package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestUTF16WordPositions(t *testing.T) {
	for _, tc := range []struct {
		name, line string
		column     int
	}{
		{"ascii", "/* text */ Target();", 11},
		{"korean", "/* 한글 */ Target();", 9},
		{"emoji", "/* 😀 */ Target();", 9},
		{"mixed", "/* 가😀 */ Target();", 10},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := wordAt(tc.line, 0, tc.column); got != "Target" {
				t.Fatalf("wordAt UTF-16 column %d = %q", tc.column, got)
			}
			byteColumn := strings.Index(tc.line, "Target")
			if got := byteColumnToUTF16(tc.line, byteColumn); got != tc.column {
				t.Fatalf("reference column = %d, want %d", got, tc.column)
			}
		})
	}
	if _, ok := utf16ColumnToByte("😀Target", 1); ok {
		t.Fatal("accepted position within a surrogate pair")
	}
	if _, ok := utf16ColumnToByte("Target", -1); ok {
		t.Fatal("accepted negative position")
	}
	if got, ok := utf16ColumnToByte("한😀", 100); !ok || got != len("한😀") {
		t.Fatalf("past-line position = %d, %v", got, ok)
	}
}

// Run the actual stdio main loop in an isolated test subprocess. Other tests
// exercise asynchronous diagnostics, so replacing global os.Stdout is unsafe.
func TestLSPProcess(t *testing.T) {
	if os.Getenv("HARNESS_LSP_TEST_PROCESS") != "1" {
		return
	}
	main()
	os.Exit(0)
}

func TestUTF16DefinitionReferencesAndHover(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestLSPProcess$")
	cmd.Env = append(os.Environ(), "HARNESS_LSP_TEST_PROCESS=1", "HARNESS_LSP_CL=", "HARNESS_LSP_DOTNET=")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stdin.Close()
		if err := cmd.Wait(); err != nil {
			t.Errorf("LSP subprocess: %v; %s", err, stderr.String())
		}
	})
	reader := bufio.NewReader(stdout)
	sendMessage := func(id int, method string, params any) {
		t.Helper()
		msg := map[string]any{"jsonrpc": "2.0", "method": method, "params": params}
		if id > 0 {
			msg["id"] = id
		}
		body, err := json.Marshal(msg)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fmt.Fprintf(stdin, "Content-Length: %d\r\n\r\n%s", len(body), body); err != nil {
			t.Fatal(err)
		}
	}
	response := func(id int) json.RawMessage {
		t.Helper()
		for {
			body, err := readMessage(reader)
			if err != nil {
				t.Fatal(err)
			}
			var msg struct {
				ID     int             `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  *rpcError       `json:"error"`
			}
			if err := json.Unmarshal(body, &msg); err != nil {
				t.Fatal(err)
			}
			if msg.ID != id {
				continue
			} // diagnostics may precede the response
			if msg.Error != nil {
				t.Fatalf("JSON-RPC error: %+v", msg.Error)
			}
			return msg.Result
		}
	}
	sendMessage(1, "initialize", map[string]any{"processId": nil, "rootUri": nil, "capabilities": map[string]any{}})
	var init struct {
		Capabilities struct {
			Encoding string `json:"positionEncoding"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(response(1), &init); err != nil {
		t.Fatal(err)
	}
	if init.Capabilities.Encoding != "utf-16" {
		t.Fatalf("positionEncoding = %q", init.Capabilities.Encoding)
	}
	sendMessage(0, "initialized", map[string]any{})
	uri := "file:///utf16-integration.cpp"
	text := "void Target() {}\nvoid Caller() { /* 한글😀 */ Target(); }\n"
	sendMessage(0, "textDocument/didOpen", map[string]any{"textDocument": map[string]any{"uri": uri, "languageId": "cpp", "version": 1, "text": text}})
	params := map[string]any{"textDocument": map[string]any{"uri": uri}, "position": Position{1, 27}, "context": map[string]any{"includeDeclaration": true}}
	for i, method := range []string{"definition", "references", "hover"} {
		sendMessage(i+2, "textDocument/"+method, params)
		result := response(i + 2)
		if method == "hover" {
			if !strings.Contains(string(result), "void Target() {}") {
				t.Fatalf("hover = %s", result)
			}
			continue
		}
		var locations []Location
		if err := json.Unmarshal(result, &locations); err != nil {
			t.Fatal(err)
		}
		if method == "definition" {
			if len(locations) != 1 || locations[0].Range.Start != (Position{0, 5}) {
				t.Fatalf("definition = %+v", locations)
			}
		} else {
			found := false
			for _, loc := range locations {
				if loc.URI == uri && loc.Range == (Range{Position{1, 27}, Position{1, 33}}) {
					found = true
				}
			}
			if !found {
				t.Fatalf("call reference absent or wrong UTF-16 range: %+v", locations)
			}
		}
	}
	sendMessage(5, "shutdown", nil)
	response(5)
	sendMessage(0, "exit", nil)
}

func TestBuiltinDiagnosticsUTF16Ranges(t *testing.T) {
	for _, prefix := range []string{"/* 한글 */ ", "/* 😀 */ ", "/* 한😀 */ "} {
		for _, bracket := range []string{"(", ")"} {
			diags := builtinDiags(prefix + bracket)
			if len(diags) != 1 {
				t.Fatalf("%q: diagnostics=%+v", prefix+bracket, diags)
			}
			column := byteColumnToUTF16(prefix, len(prefix))
			want := Range{Position{0, column}, Position{0, column + 1}}
			if diags[0].Range != want {
				t.Fatalf("%q: range=%+v, want %+v", prefix+bracket, diags[0].Range, want)
			}
		}
	}
}
