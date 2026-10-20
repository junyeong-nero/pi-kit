package main

import (
	"context"
	"errors"
	"os/exec"
	"sync"
)

type compilerBatch struct {
	scope    string
	files    map[string][]Diag
	complete bool
}

func executeCompiler(ctx context.Context, cmd *exec.Cmd, scope, source string) compilerBatch {
	output, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	// A compile failure is a completed diagnostic run. Launch failures and
	// timeouts are not evidence that a previous diagnostic has been resolved.
	if ctx.Err() != nil || (err != nil && !errors.As(err, &exit)) {
		return compilerBatch{}
	}
	return compilerBatch{scope, parseMSVC(string(output), cmd.Dir, source), true}
}

type compilerDiagnosticStore map[string]map[string][]Diag

var diagnosticMu sync.Mutex
var compilerDiagnostics = compilerDiagnosticStore{}

// Replace only this build scope; clearing its old files must preserve diagnostics
// owned by other translation units/projects and built-in checks of open buffers.
func (s compilerDiagnosticStore) update(trigger string, batch compilerBatch) map[string][]Diag {
	affected := map[string][]Diag{trigger: nil}
	if batch.complete {
		for uri := range s[batch.scope] {
			affected[uri] = nil
		}
		for uri := range batch.files {
			affected[uri] = nil
		}
		s[batch.scope] = batch.files
	}
	for uri := range affected {
		seen := map[Diag]bool{}
		for _, files := range s {
			for _, d := range files[uri] {
				if !seen[d] {
					affected[uri] = append(affected[uri], d)
					seen[d] = true
				}
			}
		}
	}
	return affected
}
