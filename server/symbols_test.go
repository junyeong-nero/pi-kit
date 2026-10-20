package main

import (
	"strings"
	"testing"
)

func TestMultilineFunctions(t *testing.T) {
	for _, tc := range []struct {
		ext, text string
		kind      int
	}{
		{"cpp", "void Target()\n{\n}\nvoid Multiline(\n int x,\n int y\n) const noexcept\n{\n}\nvoid Inline() {}\nvoid Caller() { Target(); }", SymFunction},
		{"cs", "class Example\n{\n public void Target()\n {\n }\n public void Multiline(\n int x,\n int y\n )\n {\n }\n public void Inline() {}\n public void Caller() { Target(); }\n}", SymMethod},
		{"cpp", "void Target();\nvoid Multiline(\n int x,\n int y\n);\nvoid Inline() {}\nvoid Caller() {}", SymFunction},
		{"cs", "public void Target();\npublic void Multiline(\n int x,\n int y\n);\npublic void Inline() => Target();\npublic void Caller() {}", SymMethod},
	} {
		t.Run(tc.ext+tc.text[:4], func(t *testing.T) {
			syms := parseSymbols("file:///test."+tc.ext, tc.text)
			got := map[string]symbol{}
			for _, s := range syms {
				if s.Kind == tc.kind {
					got[s.Name] = s
				}
			}
			for _, name := range []string{"Target", "Multiline", "Inline", "Caller"} {
				s, ok := got[name]
				if !ok {
					t.Errorf("missing %s: %+v", name, syms)
					continue
				}
				lines := strings.Split(tc.text, "\n")
				if got := lines[s.Line][s.Char:s.EndChar]; got != name {
					t.Errorf("range contains %q, want %q", got, name)
				}
			}
			if len(got) != 4 {
				t.Errorf("unexpected functions: %+v", got)
			}
			if !got["Inline"].Def || !got["Caller"].Def {
				t.Errorf("definitions lost: %+v", got)
			}
		})
	}
}

func TestSymbolNameCaptureRange(t *testing.T) {
	for _, tc := range []struct {
		ext, text, name string
		col, kind       int
	}{
		{"cpp", "Foo Foo(Foo f) { return {}; }", "Foo", 4, SymFunction},
		{"cpp", "Foo Foo(Foo f);", "Foo", 4, SymFunction},
		{"cpp", "Foo Foo::Foo(Foo f) {}", "Foo", 9, SymFunction},
		{"cs", "public Foo Foo(Foo f) {}", "Foo", 11, SymMethod},
		{"cs", "Foo IFoo.Foo(Foo f);", "Foo", 9, SymMethod},
		{"cs", "public class publicThing {}", "publicThing", 13, SymClass},
	} {
		t.Run(tc.ext+tc.text, func(t *testing.T) {
			syms := parseSymbols("file:///test."+tc.ext, tc.text)
			if len(syms) != 1 {
				t.Fatalf("got %+v", syms)
			}
			s := syms[0]
			if s.Name != tc.name || s.Char != tc.col || s.EndChar != tc.col+len(tc.name) || s.Kind != tc.kind {
				t.Fatalf("wrong captured symbol: %+v", s)
			}
		})
	}
}

func TestCallsAreNotSymbols(t *testing.T) {
	for _, ext := range []string{"cpp", "cs"} {
		for _, call := range []string{"Target();", "Target(Target);", "Target(\n Target\n);", "return Target();", "throw Target();", "if (Target()) {", "while (Target()) {", "object.Target();", "object.Target(Target);"} {
			t.Run(ext+call, func(t *testing.T) {
				text := call + "\nvoid Actual()\n{\n}\n"
				syms := parseSymbols("file:///test."+ext, text)
				if len(syms) != 1 || syms[0].Name != "Actual" || !syms[0].Def {
					t.Fatalf("call indexed or following definition lost: %+v", syms)
				}
			})
		}
	}
}

func TestSignatureDelimitersInCommentsAndLiterals(t *testing.T) {
	for _, tc := range []struct{ ext, text string }{
		{"cs", `public void Foo(string separator = "=>") {}`},
		{"cpp", `void Foo(const char *separator = "=>") {}`},
		{"cs", "/*\ndocumentation (see details)\n*/\nvoid Foo() {}"},
		{"cpp", "/*\ndocumentation (see details)\n*/\nvoid Foo() {}"},
		{"cpp", "void Foo(\nconst char *s = R\"tag(=>;{})tag\"\n) {}"},
		{"cs", "void Foo(\nstring s = @\"=>;{}\"\n) {}"},
		{"cpp", "/* => */ void Foo(/* ;{} */ int n)\n/* body follows */\n{}"},
	} {
		t.Run(tc.ext+tc.text, func(t *testing.T) {
			syms := parseSymbols("file:///test."+tc.ext, tc.text)
			if len(syms) != 1 || syms[0].Name != "Foo" || !syms[0].Def {
				t.Fatalf("got %+v", syms)
			}
			s := syms[0]
			line := strings.Split(tc.text, "\n")[s.Line]
			if line[s.Char:s.EndChar] != "Foo" {
				t.Fatalf("capture no longer matches source: %+v", s)
			}
		})
	}
}

func TestLargeCommentBlockDoesNotConsumeDefinition(t *testing.T) {
	text := strings.Repeat("// documentation (see details)\n", 8000) + "void Foo() {}"
	syms := parseSymbols("file:///test.cpp", text)
	if len(syms) != 1 || syms[0].Name != "Foo" || syms[0].Line != 8000 {
		t.Fatalf("got %+v", syms)
	}
}

func TestSignatureLookaheadIsBounded(t *testing.T) {
	candidate, last := signatureCandidate(strings.Split(strings.Repeat("possible(\n", 10000), "\n"), 0)
	if candidate != "" || last != 0 {
		t.Fatalf("unbounded/incomplete candidate: %d bytes, last %d", len(candidate), last)
	}
}

func TestNonASCIIPrefixPreservesCaptureUTF16(t *testing.T) {
	text := "/* 한글😀 */ void Target() {}"
	syms := parseSymbols("file:///test.cpp", text)
	if len(syms) != 1 || syms[0].Name != "Target" || syms[0].Char != 16 || syms[0].EndChar != 22 {
		t.Fatalf("got %+v", syms)
	}
}
