package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestBuiltinLiteralBrackets(t *testing.T) {
	for name, text := range map[string]string{
		"backslash parity": `void f() { const char* s = "C:\\"; }`,
		"escaped quote":    `void f() { const char* s = "\"}"; }`,
		"verbatim":         "class C { string s = @\"first\n}\nlast\"; }",
		"doubled quote":    `class C { string s = @"first "" } "" last"; }`,
		"cpp raw":          "void f() { auto s = u8R\"tag(first\n}\n\"last)tag\"; }",
		"cs raw":           "class C { string s = \"\"\"\n}\n\"\"\"; }",
		"interpolated":     `class C { string s = $"{F("}")}"; }`,
		"comments":         "void f() { /* } */ // )\n }",
	} {
		t.Run(name, func(t *testing.T) {
			language := "cpp"
			if name == "cs raw" {
				language = "csharp"
			}
			if ds := builtinDiags(text, language); len(ds) != 0 {
				t.Fatalf("unexpected: %+v", ds)
			}
		})
	}
	if ds := builtinDiags("void f() {\n]"); len(ds) == 0 {
		t.Fatal("real mismatched brackets were ignored")
	}
}

func TestCompilerRoutingAndClearing(t *testing.T) {
	dir := t.TempDir()
	a, b, h := uriOfPath(filepath.Join(dir, "A.cs")), uriOfPath(filepath.Join(dir, "B.cs")), uriOfPath(filepath.Join(dir, "include", "b.h"))
	output := fmt.Sprintf("%s(42,7): error CS1002: ; expected\nA.cs(2): warning CS1: warning\ninclude/b.h(3,4): error C1: header error\n", filepath.Join(dir, "B.cs"))
	ds := parseMSVC(output, dir, "dotnet")
	if len(ds[a]) != 1 || len(ds[b]) != 1 || len(ds[h]) != 1 || ds[b][0].Range.Start != (Position{41, 6}) {
		t.Fatalf("routing: %+v", ds)
	}
	store := compilerDiagnosticStore{}
	got := store.update(a, compilerBatch{"project", ds, true})
	if len(got[b]) != 1 {
		t.Fatal("missing B publication")
	}
	store.update(a, compilerBatch{"other", map[string][]Diag{h: ds[h]}, true})
	got = store.update(a, compilerBatch{"project", map[string][]Diag{}, true})
	if len(got[b]) != 0 {
		t.Fatal("old B errors not cleared")
	}
	if _, ok := got[b]; !ok {
		t.Fatal("missing B clear publication")
	}
	if len(got[h]) != 1 {
		t.Fatal("cleared another translation unit's header error")
	}
	got = store.update(h, compilerBatch{})
	if len(got[h]) != 1 {
		t.Fatal("incomplete execution cleared prior diagnostics")
	}
}

func TestCompilerHelper(t *testing.T) {
	if os.Getenv("HARNESS_COMPILER_HELPER") != "1" {
		return
	}
	fmt.Println("B.cs(42,7): error CS1002: ; expected")
	os.Exit(1)
}

func TestExecuteCompiler(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestCompilerHelper$")
	cmd.Env = append(os.Environ(), "HARNESS_COMPILER_HELPER=1")
	cmd.Dir = t.TempDir()
	batch := executeCompiler(context.Background(), cmd, "project", "dotnet")
	uri := uriOfPath(filepath.Join(cmd.Dir, "B.cs"))
	if !batch.complete || len(batch.files[uri]) != 1 {
		t.Fatalf("actual failed compiler output was lost: %+v", batch)
	}
	missing := exec.Command(filepath.Join(t.TempDir(), "missing-compiler"))
	if got := executeCompiler(context.Background(), missing, "project", "dotnet"); got.complete {
		t.Fatal("launch failure considered clean build")
	}
}

func TestAdjacentCPPStringsStillCheckBrackets(t *testing.T) {
	for _, text := range []string{`void f() { const char *s = """";`, `void f() { const char *s = """""";`} {
		if got := builtinDiags(text, "cpp"); len(got) != 1 {
			t.Fatalf("missing opening-brace diagnostic for %q: %+v", text, got)
		}
	}
}

func TestSlowCompilerDoesNotBlockBuiltinsAndCoalesces(t *testing.T) {
	t.Setenv("HARNESS_LSP_DOTNET", "1")
	t.Setenv("HARNESS_LSP_CL", "")
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Test.csproj"), []byte("<Project />"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "A.cs"), []byte("class A {}"), 0600); err != nil {
		t.Fatal(err)
	}
	a := uriOfPath(filepath.Join(dir, "A.cs"))
	b := uriOfPath(filepath.Join(dir, "B.cpp"))
	setDoc := func(uri, text, language string) {
		mu.Lock()
		docs[uri] = &doc{URI: uri, Text: text, LanguageID: language}
		revisions[uri]++
		mu.Unlock()
	}
	setDoc(a, "class A {}", "csharp")
	setDoc(b, "void f() {", "cpp")
	t.Cleanup(func() {
		mu.Lock()
		delete(docs, a)
		delete(docs, b)
		revisions[a]++
		revisions[b]++
		mu.Unlock()
	})
	type publication struct {
		uri   string
		diags []Diag
	}
	published := make(chan publication, 20)
	emit := func(uri string, ds []Diag) { published <- publication{uri, ds} }
	started := make(chan diagnosticJob, 5)
	finished := make(chan diagnosticJob, 5)
	release := make(chan struct{})
	defer close(release)
	queue := &diagnosticScheduler{
		run: func(job diagnosticJob) compilerBatch {
			started <- job
			<-release
			return compilerBatch{job.scope, map[string][]Diag{a: {{Severity: 1, Source: "fake", Message: job.text}}}, true}
		},
		emit: func(job diagnosticJob, batch compilerBatch) {
			publishCurrentDiagnostics(job, batch, emit)
			finished <- job
		},
	}
	runDiagnosticsWith(a, "class A {}", queue, emit)
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("compiler did not start")
	}
	unrelated := make(chan struct{})
	go func() { runDiagnosticsWith(b, "void f() {", queue, emit); close(unrelated) }()
	select {
	case <-unrelated:
	case <-time.After(2 * time.Second):
		t.Fatal("unrelated built-in checks blocked on compiler")
	}
	found := false
	for len(published) > 0 {
		p := <-published
		if p.uri == b && len(p.diags) == 1 && p.diags[0].Source == "harness" {
			found = true
		}
	}
	if !found {
		t.Fatal("unrelated missing brace was not published")
	}
	setDoc(a, "class A { }", "csharp")
	runDiagnosticsWith(a, "class A { }", queue, emit)
	setDoc(a, "class A {  }", "csharp")
	runDiagnosticsWith(a, "class A {  }", queue, emit)
	release <- struct{}{}
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("first compiler did not finish")
	}
	select {
	case job := <-started:
		if job.text != "class A {  }" {
			t.Fatalf("pending compiler request not coalesced: %+v", job)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("latest compiler did not start")
	}
	release <- struct{}{}
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("latest compiler did not finish")
	}
	for len(published) > 0 {
		p := <-published
		for _, d := range p.diags {
			if d.Source == "fake" && d.Message != "class A {  }" {
				t.Fatalf("stale compiler result published: %+v", d)
			}
		}
	}
	// The controlled build scope must not leak into subsequent tests.
	diagnosticMu.Lock()
	delete(compilerDiagnostics, "dotnet:"+filepath.Join(dir, "Test.csproj"))
	diagnosticMu.Unlock()
}
