package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type diagnosticJob struct {
	uri, text, scope, path string
	revision               uint64
}

// One external build runs at a time. A burst of changes retains at most one
// pending request per project/translation unit, rather than spawning a build
// for every keystroke. Built-in checks never wait for this worker.
type diagnosticScheduler struct {
	mu      sync.Mutex
	pending map[string]diagnosticJob
	order   []string
	running bool
	active  diagnosticJob
	run     func(diagnosticJob) compilerBatch
	emit    func(diagnosticJob, compilerBatch)
}

func (s *diagnosticScheduler) submit(job diagnosticJob) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running && s.active == job {
		return
	}
	if s.pending == nil {
		s.pending = map[string]diagnosticJob{}
	}
	if _, ok := s.pending[job.scope]; !ok {
		s.order = append(s.order, job.scope)
	}
	s.pending[job.scope] = job
	if !s.running {
		s.running = true
		go s.work()
	}
}

func (s *diagnosticScheduler) work() {
	for {
		s.mu.Lock()
		if len(s.order) == 0 {
			s.running = false
			s.active = diagnosticJob{}
			s.mu.Unlock()
			return
		}
		scope := s.order[0]
		s.order = s.order[1:]
		job := s.pending[scope]
		delete(s.pending, scope)
		s.active = job
		s.mu.Unlock()
		batch := s.run(job)
		s.emit(job, batch)
	}
}

var compilerQueue = &diagnosticScheduler{
	run: func(job diagnosticJob) compilerBatch {
		mu.RLock()
		current := diagnosticJobCurrent(job)
		mu.RUnlock()
		if !current {
			return compilerBatch{}
		}
		if strings.HasPrefix(job.scope, "dotnet:") {
			return dotnetDiags(job.path)
		}
		return clDiags(job.path)
	},
	emit: func(job diagnosticJob, batch compilerBatch) { publishCurrentDiagnostics(job, batch, publish) },
}

// Caller holds mu.RLock. Revisions distinguish close/reopen and edits that
// return to identical text, for which comparing the text alone is insufficient.
func diagnosticJobCurrent(job diagnosticJob) bool {
	d := docs[job.uri]
	return d != nil && d.Text == job.text && revisions[job.uri] == job.revision
}

func runDiagnosticsWith(uri, text string, queue *diagnosticScheduler, emit func(string, []Diag)) {
	mu.RLock()
	job := diagnosticJob{uri: uri, text: text, revision: revisions[uri]}
	current := diagnosticJobCurrent(job)
	mu.RUnlock()
	if !current {
		return
	}
	publishCurrentDiagnostics(job, compilerBatch{}, emit)
	p, ok := pathOfURI(uri)
	if !ok {
		return
	}
	p, err := filepath.Abs(p)
	if err != nil {
		return
	}
	job.path = p
	if strings.HasSuffix(strings.ToLower(p), ".cs") {
		if os.Getenv("HARNESS_LSP_DOTNET") == "" {
			return
		}
		root := findDotnetRoot(p)
		if root == "" {
			return
		}
		job.scope = "dotnet:" + root
	} else {
		if os.Getenv("HARNESS_LSP_CL") == "" {
			return
		}
		job.scope = "cl:" + p
	}
	mu.RLock()
	if diagnosticJobCurrent(job) {
		queue.submit(job)
	}
	mu.RUnlock()
}

func publishCurrentDiagnostics(job diagnosticJob, batch compilerBatch, emit func(string, []Diag)) {
	diagnosticMu.Lock()
	defer diagnosticMu.Unlock()
	mu.RLock()
	defer mu.RUnlock()
	if !diagnosticJobCurrent(job) {
		return
	}
	for target, diags := range compilerDiagnostics.update(job.uri, batch) {
		if d := docs[target]; d != nil {
			language := d.LanguageID
			if language == "" && strings.HasSuffix(strings.ToLower(target), ".cs") {
				language = "csharp"
			}
			diags = append(builtinDiags(d.Text, language), diags...)
		}
		emit(target, diags)
	}
}
