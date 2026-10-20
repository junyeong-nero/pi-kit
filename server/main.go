// cpp-csharp-lsp-lite: 보관 중인 경량 standalone LSP (C++/C#, Visual Studio 환경).
//
// 의존성 0개 (stdlib만). 폐쇄망 배포 전제.
//
// 빌드 (저장소 루트에서):
//
//	go mod vendor            # 외부 의존성이 없으므로 사실상 no-op (감사 기록용)
//	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags="-s -w" -o cpp-csharp-lsp-lite.exe ./server
//
// 새 오프라인 배포물은 clangd/csharp-ls를 사용하며 이 Go 서버를 포함하지 않는다.
// 이 구현은 표준 LSP 클라이언트의 stdio 연결로 별도 실행할 수 있다.
//
// 동작:
//   - 심볼/정의/참조/hover: 정규식 인덱스 (저장된 파일이 아닌 열린 버퍼 기준, 즉시 응답)
//   - diagnostics: 기본 내장 검사(괄호/브레이스 짝) + opt-in 외부 툴체인 포워딩
//     HARNESS_LSP_CL=1      -> cl.exe /nologo /Zs (디스크에 저장된 파일 기준)
//     HARNESS_LSP_DOTNET=1  -> dotnet build (sln/csproj 기준, 느림 주의)
//     둘 다 끄면(기본값) 외부 프로세스를 절대 띄우지 않음.
//
// 로그는 절대 stdout에 쓰지 않는다 (stdio JSON-RPC와 충돌). stderr로만.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- JSON-RPC framing ----------

const serverVersion = "0.2.2"

var stdoutMu sync.Mutex

type incoming struct {
	Jsonrpc string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method"`
	Params  json.RawMessage  `json:"params,omitempty"`
}

type outgoing struct {
	Jsonrpc string      `json:"jsonrpc"`
	ID      interface{} `json:"id,omitempty"`
	Result  interface{} `json:"result,omitempty"`
	Error   *rpcError   `json:"error,omitempty"`
	Method  string      `json:"method,omitempty"`
	Params  interface{} `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[cpp-csharp-lsp-lite] "+format+"\n", a...)
}

func send(msg outgoing) {
	msg.Jsonrpc = "2.0"
	body, err := json.Marshal(msg)
	if err != nil {
		logf("marshal: %v", err)
		return
	}
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	fmt.Fprintf(os.Stdout, "Content-Length: %d\r\n\r\n%s", len(body), body)
}

func respond(id *json.RawMessage, result interface{}) {
	var v interface{}
	if id != nil {
		var tmp interface{}
		_ = json.Unmarshal(*id, &tmp)
		v = tmp
	}
	if result == nil {
		// JSON-RPC 응답은 result/error 중 하나가 반드시 있어야 한다.
		// omitempty가 nil을 통째로 지워버리는 것을 방지.
		result = json.RawMessage("null")
	}
	send(outgoing{ID: v, Result: result})
}

func respondErr(id *json.RawMessage, code int, message string) {
	var v interface{}
	if id != nil {
		var tmp interface{}
		_ = json.Unmarshal(*id, &tmp)
		v = tmp
	}
	send(outgoing{ID: v, Error: &rpcError{Code: code, Message: message}})
}

func notify(method string, params interface{}) {
	send(outgoing{Method: method, Params: params})
}

func readMessage(r *bufio.Reader) ([]byte, error) {
	headers := map[string]string{}
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if i := strings.Index(line, ":"); i > 0 {
			headers[strings.ToLower(strings.TrimSpace(line[:i]))] = strings.TrimSpace(line[i+1:])
		}
	}
	n, err := strconv.Atoi(headers["content-length"])
	if err != nil || n < 0 {
		return nil, fmt.Errorf("bad Content-Length %q", headers["content-length"])
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// ---------- LSP-ish types ----------

type Position struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}
type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}
type Location struct {
	URI   string `json:"uri"`
	Range Range  `json:"range"`
}
type SymbolInfo struct {
	Name          string   `json:"name"`
	Kind          int      `json:"kind"`
	Location      Location `json:"location"`
	ContainerName string   `json:"containerName,omitempty"`
}
type Diag struct {
	Range    Range  `json:"range"`
	Severity int    `json:"severity"` // 1=Error 2=Warning 3=Info 4=Hint
	Source   string `json:"source"`
	Message  string `json:"message"`
	Code     string `json:"code,omitempty"`
}

const (
	SymClass     = 5
	SymMethod    = 6
	SymInterface = 11
	SymFunction  = 12
	SymConstant  = 14
	SymEnum      = 10
)

// ---------- document store + index ----------

type doc struct {
	URI        string
	LanguageID string
	Version    int32
	Text       string
}

type symbol struct {
	Name      string
	Kind      int
	URI       string
	Line      int
	Char      int
	EndLine   int
	EndChar   int
	Container string
	Def       bool // true면 { 또는 => 로 끝나는 진짜 정의 (선언/호출 잔재와 구분용)
}

var (
	mu    sync.RWMutex
	docs  = map[string]*doc{}     // 클라이언트가 연 문서 (didOpen 기준, 최신 버퍼)
	index = map[string][]symbol{} // uri -> 심볼 (열린 문서 + 워크스페이스 스캔 결과)
	// 디스크에서 읽어 캐시한 파일 내용 (아직 open 안 된 파일의 정의/참조용).
	// 열린 문서는 docs가 우선하고, didClose에서 현재 디스크 내용을 다시 읽는다.
	fileCache = map[string]string{}
	// Revisions invalidate in-flight disk reads when document ownership changes.
	revisions = map[string]uint64{}
)

const (
	maxWalkFiles = 3000
	maxFileBytes = 2 << 20 // 2MB
)

var indexExts = map[string]bool{
	".cs": true, ".cpp": true, ".h": true, ".hpp": true,
	".c": true, ".cc": true, ".cxx": true,
}

var skipDirs = map[string]bool{
	".git": true, ".vs": true, "bin": true, "obj": true,
	"node_modules": true, "TestResults": true, "packages": true,
}

var (
	// C++: 접두사는 반드시 공백 또는 :: 로 끝나야 한다.
	// (구분자 없이 두면 "drawPixel("이 접두사 "d"+이름 "rawPixel"로 찢어진다.)
	// 덕분에 Foo::Bar() 같은 한정 정의도 매칭된다.
	reCppType   = regexp.MustCompile(`^\s*(?:class|struct|enum(?:\s+class)?|union)\s+(\w+)`)
	reCppDefine = regexp.MustCompile(`^\s*#\s*define\s+(\w+)`)
	reCppFunc   = regexp.MustCompile(`^\s*(?:[\w:\<\>\&\*][\w:\<\>\&\*\s]*?(?:\s+|::))?(~?\w+(?:<[^;{}]*>)?)\s*\([^;{}]*?\)\s*(?::\s*[^{};]+)?\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(\{|\;)`)
	// C#: TYPE은 공백으로 끝나는 토큰열, 한정자(NS.)는 별도.
	// (void IFoo.Bar() 같은 명시적 구현과 s.Get() 같은 호출을 구분하기 위함.)
	reCsType   = regexp.MustCompile(`^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|unsafe)\s+)*(?:class|interface|enum|record|struct)\s+(\w+)`)
	reCsMethod = regexp.MustCompile(`^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|extern|unsafe|new|partial|readonly|volatile)\s+)*(?:[\w\<\>\[\]\?,\.]+(?:\s+[\w\<\>\[\]\?,\.]+)*\s+)?(?:[\w]+\.)*(~?\w+(?:<[^;{}]*>)?)\s*\([^;{}]*?\)\s*(?::\s*[^{};]+)?\s*(?:where\s+[^{};]+)?\s*(\{|;|=>)`)
)

// skipFirst: 행 첫 단어가 이 집합이면 함수/메서드 정의일 수 없으므로 스킵.
// (return foo();, throw Bar();, new Foo();, case 1: f(); 등 호출문 제외용.
// async/unsafe/static 등 정의문에 올 수 있는 단어는 절대 넣지 말 것.)
var skipFirst = map[string]bool{
	"return": true, "co_return": true, "co_await": true, "co_yield": true,
	"throw": true, "delete": true, "new": true, "emit": true,
	"await": true, "yield": true,
	"if": true, "for": true, "while": true, "switch": true, "catch": true,
	"else": true, "do": true, "try": true, "finally": true,
	"foreach": true, "lock": true, "using": true, "fixed": true,
	"checked": true, "unchecked": true, "case": true, "default": true,
	"goto": true, "sizeof": true,
}

// firstWord: 행의 첫 영단어 (앞의 ~, 공백 등 무시)
func firstWord(ln string) string {
	i := 0
	for i < len(ln) && !isWordByte(ln[i]) {
		i++
	}
	j := i
	for j < len(ln) && isWordByte(ln[j]) {
		j++
	}
	return ln[i:j]
}

func langOf(uri string) string {
	u := strings.ToLower(uri)
	if strings.HasSuffix(u, ".cs") {
		return "cs"
	}
	return "cpp" // c/h/cpp/hpp 포함
}

func rebuildIndex(uri, text string) {
	syms := parseSymbols(uri, text)
	mu.Lock()
	index[uri] = syms
	mu.Unlock()
}

// parseSymbols keeps parsing independent of the shared document/index state.
func parseSymbols(uri, text string) []symbol {
	lang := langOf(uri)
	sourceLines := strings.Split(text, "\n")
	lines := strings.Split(maskSymbolNonCode(text), "\n")
	lineOffsets := make([]int, len(lines))
	for i := 1; i < len(lines); i++ {
		lineOffsets[i] = lineOffsets[i-1] + len(lines[i-1]) + 1
	}
	var syms []symbol
	var container string
	for i := 0; i < len(lines); i++ {
		ln := lines[i]
		trimmed := strings.TrimSpace(ln)
		var re *regexp.Regexp
		kind := SymClass
		if lang == "cs" {
			re = reCsType
		} else if reCppDefine.MatchString(ln) {
			re, kind = reCppDefine, SymConstant
		} else {
			re = reCppType
		}
		m := re.FindStringSubmatchIndex(ln)
		candidate := ln
		isDef := true
		lastLine := i
		if m != nil {
			if kind == SymClass {
				if strings.Contains(ln[:m[2]], "interface") {
					kind = SymInterface
				} else if strings.Contains(ln[:m[2]], "enum") {
					kind = SymEnum
				}
				container = ln[m[2]:m[3]]
			}
		} else {
			if skipFirst[firstWord(trimmed)] || trimmed == "" {
				continue
			}
			// Only extend a possible signature. A statement/body delimiter stops
			// the scan, so a call cannot absorb the following function's body.
			if strings.Contains(ln, "(") {
				candidate, lastLine = signatureCandidate(lines, i)
			}
			if lang == "cs" {
				re, kind = reCsMethod, SymMethod
			} else {
				re, kind = reCppFunc, SymFunction
			}
			m = re.FindStringSubmatchIndex(candidate)
			if m == nil {
				continue
			}
			name := candidate[m[2]:m[3]]
			if isControlKeyword(name) {
				continue
			}
			ending := candidate[m[4]:m[5]]
			// Use the captured name's offset, even if its spelling occurs in
			// the return type, qualifier, or argument list as well.
			prefix := strings.TrimSpace(candidate[:m[2]])
			if ending == ";" {
				if lang == "cs" && isCsCallPrefix(prefix) {
					continue
				}
				if lang != "cs" && prefix == "" && !strings.HasPrefix(name, "~") {
					continue
				}
			}
			isDef = ending == "{" || ending == "=>"
		}
		startLine, startCol := capturePosition(candidate, i, m[2])
		endLine, endCol := capturePosition(candidate, i, m[3])
		syms = append(syms, symbol{
			Name: text[lineOffsets[startLine]+startCol : lineOffsets[endLine]+endCol], Kind: kind, URI: uri,
			Line: startLine, Char: byteColumnToUTF16(sourceLines[startLine], startCol),
			EndLine: endLine, EndChar: byteColumnToUTF16(sourceLines[endLine], endCol),
			Container: container, Def: isDef,
		})
		i = lastLine
	}
	return syms
}

// signatureCandidate reads through the first declaration/body delimiter. Keep
// newlines intact so regexp capture offsets map back to the original document.
func signatureCandidate(lines []string, first int) (string, int) {
	var candidate strings.Builder
	// Bound speculative lookahead on incomplete or malformed signatures.
	for i := first; i < len(lines) && i-first < 256; i++ {
		if candidate.Len()+len(lines[i]) > 64<<10 {
			break
		}
		if i > first {
			candidate.WriteByte('\n')
		}
		ln := lines[i]
		end, width := strings.IndexAny(ln, ";{}"), 1
		if arrow := strings.Index(ln, "=>"); arrow >= 0 && (end < 0 || arrow < end) {
			end, width = arrow, 2
		}
		if end >= 0 {
			candidate.WriteString(ln[:end+width])
			return candidate.String(), i
		}
		candidate.WriteString(ln)
	}
	return "", first
}

func capturePosition(candidate string, firstLine, offset int) (int, int) {
	prefix := candidate[:offset]
	return firstLine + strings.Count(prefix, "\n"), offset - strings.LastIndex(prefix, "\n") - 1
}

// A bare name or a whitespace-free member access is a C# call, not a declaration.
func isCsCallPrefix(prefix string) bool {
	return prefix == "" || strings.Contains(prefix, ".") && !strings.ContainsAny(prefix, " \t\r\n")
}

func isControlKeyword(w string) bool {
	switch w {
	case "if", "for", "while", "switch", "catch", "return", "foreach", "using",
		"lock", "else", "do", "try", "finally", "when", "where", "get", "set":
		return true
	}
	return false
}

func wordAt(text string, line, char int) string {
	lines := strings.Split(text, "\n")
	if line < 0 || line >= len(lines) {
		return ""
	}
	ln := lines[line]
	column, ok := utf16ColumnToByte(ln, char)
	if !ok {
		return ""
	}
	start, end := column, column
	for start > 0 && isWordByte(ln[start-1]) {
		start--
	}
	for end < len(ln) && isWordByte(ln[end]) {
		end++
	}
	return ln[start:end]
}

func isWordByte(b byte) bool {
	return b == '_' || 'a' <= b && b <= 'z' || 'A' <= b && b <= 'Z' || '0' <= b && b <= '9'
}

// ---------- diagnostics ----------

// 내장 검사: 문자열/문자/주석을 제외한 괄호·브레이스·브래킷 짝 검사. 저장 안 된 버퍼에도 동작.
func builtinByteDiags(text string, language ...string) []Diag {
	var out []Diag
	type open struct {
		ch   rune
		line int
		col  int
	}
	var stack []open
	line, col := 0, 0
	lang := ""
	if len(language) > 0 {
		lang = language[0]
	}
	masked, safe := maskDiagnosticLiterals(text, lang)
	if !safe {
		return nil // Unsupported interpolation: avoid speculative bracket errors.
	}
	for i := 0; i < len(masked); i++ {
		b := masked[i]
		if b == '\n' {
			line++
			col = 0
			continue
		}
		switch b {
		case '(', '[', '{':
			stack = append(stack, open{rune(b), line, col})
		case ')', ']', '}':
			want := '('
			switch b {
			case ')':
				want = '('
			case ']':
				want = '['
			case '}':
				want = '{'
			}
			if len(stack) == 0 {
				out = append(out, Diag{
					Range:    Range{Position{line, col}, Position{line, col + 1}},
					Severity: 1, Source: "harness",
					Message: fmt.Sprintf("짝 없는 닫는 괄호 '%c'", b),
				})
			} else {
				top := stack[len(stack)-1]
				if top.ch != want {
					out = append(out, Diag{
						Range:    Range{Position{line, col}, Position{line, col + 1}},
						Severity: 1, Source: "harness",
						Message: fmt.Sprintf("괄호 불일치: '%c'에 대해 '%c' 예상", b, want),
					})
				} else {
					stack = stack[:len(stack)-1]
				}
			}
		}
		col++
	}
	for _, o := range stack {
		out = append(out, Diag{
			Range:    Range{Position{o.line, o.col}, Position{o.line, o.col + 1}},
			Severity: 1, Source: "harness",
			Message: fmt.Sprintf("닫히지 않은 '%c'", o.ch),
		})
	}
	return out
}

func pathOfURI(uri string) (string, bool) {
	const prefix = "file://"
	if !strings.HasPrefix(uri, prefix) {
		return "", false
	}
	p := strings.TrimPrefix(uri, prefix)
	// %3A 같은 퍼센트 인코딩 해제 (Windows 드라이브 문자 등)
	if u, err := url.PathUnescape(p); err == nil {
		p = u
	}
	// Windows: file:///C:/... -> C:/...
	if len(p) > 2 && p[0] == '/' && p[2] == ':' {
		p = p[1:]
	}
	return filepath.FromSlash(p), true
}

// uriOfPath: 디스크 경로 -> LSP 클라이언트가 이해하는 file:// URI.
// url.URL 경유로 퍼센트 인코딩을 표준대로 처리 (공백·한글 경로 대응).
func uriOfPath(path string) string {
	slash := filepath.ToSlash(path)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash // Windows: C:/... -> /C:/...
	}
	u := url.URL{Scheme: "file", Path: slash}
	return u.String()
}

// 클라이언트가 아직 open하지 않은 파일의 정의/참조를 위해 필요.
// diskRevision captures ownership before any disk I/O. Publication checks it again.
func diskRevision(uri string) (uint64, bool) {
	mu.RLock()
	defer mu.RUnlock()
	_, indexed := index[uri]
	_, open := docs[uri]
	return revisions[uri], !indexed && !open
}

func publishDisk(uri, text string, syms []symbol, revision uint64) bool {
	mu.Lock()
	defer mu.Unlock()
	if _, open := docs[uri]; open || revisions[uri] != revision {
		return false
	}
	fileCache[uri] = text
	index[uri] = syms
	revisions[uri]++
	return true
}

func ensureIndexed(uri string) {
	revision, needed := diskRevision(uri)
	if !needed {
		return
	}
	p, ok := pathOfURI(uri)
	if !ok {
		return
	}
	fi, err := os.Stat(p)
	if err != nil || fi.IsDir() || fi.Size() > maxFileBytes {
		return
	}
	b, err := os.ReadFile(p)
	if err != nil || len(b) > maxFileBytes {
		return
	}
	text := string(b)
	publishDisk(uri, text, parseSymbols(uri, text), revision)
}

// walkWorkspace: initialize 직후 루트 아래 소스 파일을 백그라운드로 인덱싱.
// 크로스파일 정의/참조가 동작하기 위한 핵심.
func walkWorkspace(root string) {
	if root == "" {
		return
	}
	count := 0
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !indexExts[strings.ToLower(filepath.Ext(path))] {
			return nil
		}
		if count >= maxWalkFiles {
			return filepath.SkipAll
		}
		fi, err := d.Info()
		if err != nil || fi.Size() > maxFileBytes {
			return nil
		}
		ensureIndexed(uriOfPath(path))
		count++
		return nil
	})
	logf("workspace indexed: %d files under %s", count, root)
}

func rootPathFromInit(params json.RawMessage) string {
	var p struct {
		RootURI          string `json:"rootUri"`
		RootPath         string `json:"rootPath"`
		WorkspaceFolders []struct {
			URI string `json:"uri"`
		} `json:"workspaceFolders"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return ""
	}
	uris := []string{}
	if len(p.WorkspaceFolders) > 0 {
		uris = append(uris, p.WorkspaceFolders[0].URI)
	}
	uris = append(uris, p.RootURI)
	for _, u := range uris {
		if path, ok := pathOfURI(u); ok {
			return path
		}
	}
	if p.RootPath != "" {
		return p.RootPath
	}
	return ""
}

func publish(uri string, diags []Diag) {
	if diags == nil {
		diags = []Diag{}
	}
	notify("textDocument/publishDiagnostics", map[string]interface{}{
		"uri":         uri,
		"diagnostics": diags,
	})
}

// 외부 툴체인 포워딩 (opt-in). 느릴 수 있으므로 별도 고루틴+타임아웃으로 호출할 것.
func clDiags(path string) compilerBatch {
	if os.Getenv("HARNESS_LSP_CL") == "" {
		return compilerBatch{}
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return compilerBatch{}
	}
	if _, err := os.Stat(path); err != nil {
		return compilerBatch{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "cl", "/nologo", "/Zs", path)
	cmd.Dir = filepath.Dir(path)
	return executeCompiler(ctx, cmd, "cl:"+path, "msvc")
}

// cl/csc/dotnet 공통: "C:\a\b.cpp(12,5): error C2143: ..." / "(12): warning ..." 파싱
var reMSVC = regexp.MustCompile(`(?m)^(.*)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning|info)\s*([^:]*):\s*(.*)$`)

func parseMSVC(output, cwd, source string) map[string][]Diag {
	out := map[string][]Diag{}
	for _, m := range reMSVC.FindAllStringSubmatch(output, -1) {
		line, _ := strconv.Atoi(m[2])
		col := 1
		if m[3] != "" {
			col, _ = strconv.Atoi(m[3])
		}
		sev := 3
		switch strings.ToLower(m[4]) {
		case "error":
			sev = 1
		case "warning":
			sev = 2
		}
		msg := strings.TrimSpace(m[6])
		if code := strings.TrimSpace(m[5]); code != "" {
			msg = code + ": " + msg
		}
		path := strings.TrimSpace(m[1])
		if path == "" {
			continue
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(cwd, path)
		}
		uri := uriOfPath(filepath.Clean(path))
		out[uri] = append(out[uri], Diag{
			Range:    Range{Position{imax(line-1, 0), imax(col-1, 0)}, Position{imax(line-1, 0), imax(col-1, 0) + 1}},
			Severity: sev, Source: source, Message: msg, Code: strings.TrimSpace(m[5]),
		})
	}
	return out
}

func dotnetDiags(startPath string) compilerBatch {
	if os.Getenv("HARNESS_LSP_DOTNET") == "" {
		return compilerBatch{}
	}
	root := findDotnetRoot(startPath)
	if root == "" {
		return compilerBatch{}
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return compilerBatch{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "dotnet", "build", root, "--no-restore", "--nologo", "-v", "q")
	cmd.Dir = filepath.Dir(root)
	return executeCompiler(ctx, cmd, "dotnet:"+root, "dotnet")
}

func findDotnetRoot(start string) string {
	dir := start
	if fi, err := os.Stat(start); err == nil && !fi.IsDir() {
		dir = filepath.Dir(start)
	}
	for i := 0; i < 12; i++ {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return ""
		}
		for _, e := range entries {
			n := strings.ToLower(e.Name())
			if strings.HasSuffix(n, ".sln") || strings.HasSuffix(n, ".csproj") {
				return filepath.Join(dir, e.Name())
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
	return ""
}

func runDiagnostics(uri, text string) {
	runDiagnosticsWith(uri, text, compilerQueue, publish)
}

func imax(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ---------- handlers ----------

func handleInitialize(id *json.RawMessage, params json.RawMessage) {
	respond(id, map[string]interface{}{
		"capabilities": map[string]interface{}{
			"positionEncoding":        "utf-16",
			"textDocumentSync":        1, // Full
			"definitionProvider":      true,
			"referencesProvider":      true,
			"documentSymbolProvider":  true,
			"workspaceSymbolProvider": true,
			"hoverProvider":           true,
		},
		"serverInfo": map[string]interface{}{"name": "cpp-csharp-lsp-lite", "version": serverVersion},
	})
	// 크로스파일 정의/참조용: 워크스페이스 전체를 백그라운드로 인덱싱.
	// initialize 응답을 먼저 보내 클라이언트의 timeout을 피하고, 스캔은 뒤에서 돌린다.
	if root := rootPathFromInit(params); root != "" {
		go walkWorkspace(root)
	}
}

func handleDidOpen(params json.RawMessage) {
	var p struct {
		TextDocument struct {
			URI        string `json:"uri"`
			LanguageID string `json:"languageId"`
			Version    int32  `json:"version"`
			Text       string `json:"text"`
		} `json:"textDocument"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return
	}
	text := p.TextDocument.Text
	uri := p.TextDocument.URI
	mu.Lock()
	docs[uri] = &doc{uri, p.TextDocument.LanguageID, p.TextDocument.Version, text}
	index[uri] = parseSymbols(uri, text)
	revisions[uri]++
	mu.Unlock()
	go runDiagnostics(uri, text)
}

func handleDidChange(params json.RawMessage) {
	var p struct {
		TextDocument struct {
			URI     string `json:"uri"`
			Version int32  `json:"version"`
		} `json:"textDocument"`
		ContentChanges []struct {
			Text string `json:"text"`
		} `json:"contentChanges"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return
	}
	if len(p.ContentChanges) == 0 {
		return
	}
	text := p.ContentChanges[len(p.ContentChanges)-1].Text
	mu.Lock()
	if d, ok := docs[p.TextDocument.URI]; ok {
		d.Text = text
		d.Version = p.TextDocument.Version
	} else {
		docs[p.TextDocument.URI] = &doc{p.TextDocument.URI, "", p.TextDocument.Version, text}
	}
	index[p.TextDocument.URI] = parseSymbols(p.TextDocument.URI, text)
	revisions[p.TextDocument.URI]++
	mu.Unlock()
	go runDiagnostics(p.TextDocument.URI, text)
}

func handleDidClose(params json.RawMessage) {
	var p struct {
		TextDocument struct {
			URI string `json:"uri"`
		} `json:"textDocument"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return
	}
	mu.Lock()
	delete(docs, p.TextDocument.URI)
	invalidateDiskLocked(p.TextDocument.URI)
	mu.Unlock()
	// Closing discards unsaved edits and reloads the current saved file.
	ensureIndexed(p.TextDocument.URI)
	publish(p.TextDocument.URI, []Diag{})
}

func handleDidChangeWatchedFiles(params json.RawMessage) {
	var p struct {
		Changes []struct {
			URI  string `json:"uri"`
			Type int    `json:"type"` // 1=Created 2=Changed 3=Deleted
		} `json:"changes"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return
	}
	for _, c := range p.Changes {
		mu.Lock()
		invalidateDiskLocked(c.URI)
		mu.Unlock()
		if c.Type != 3 {
			ensureIndexed(c.URI)
		}
	}
}

// Caller holds mu. An open buffer remains authoritative even if its file changes.
func invalidateDiskLocked(uri string) {
	revisions[uri]++
	delete(fileCache, uri)
	if _, open := docs[uri]; !open {
		delete(index, uri)
	}
}

func toSymbolInfo(s symbol) SymbolInfo {
	return SymbolInfo{
		Name: s.Name, Kind: s.Kind,
		Location:      Location{URI: s.URI, Range: Range{Position{s.Line, s.Char}, Position{s.EndLine, s.EndChar}}},
		ContainerName: s.Container,
	}
}

func handleDocumentSymbol(id *json.RawMessage, params json.RawMessage) {
	var p struct {
		TextDocument struct {
			URI string `json:"uri"`
		} `json:"textDocument"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		respondErr(id, -32602, "bad params")
		return
	}
	mu.RLock()
	syms := append([]symbol(nil), index[p.TextDocument.URI]...)
	mu.RUnlock()
	infos := make([]SymbolInfo, 0, len(syms))
	for _, s := range syms {
		infos = append(infos, toSymbolInfo(s))
	}
	respond(id, infos)
}

func handleWorkspaceSymbol(id *json.RawMessage, params json.RawMessage) {
	var p struct {
		Query string `json:"query"`
	}
	_ = json.Unmarshal(params, &p)
	q := strings.ToLower(p.Query)
	mu.RLock()
	defer mu.RUnlock()
	var out []SymbolInfo
	for _, syms := range index {
		for _, s := range syms {
			if q == "" || strings.Contains(strings.ToLower(s.Name), q) {
				out = append(out, toSymbolInfo(s))
				if len(out) >= 100 {
					respond(id, out)
					return
				}
			}
		}
	}
	if out == nil {
		out = []SymbolInfo{}
	}
	respond(id, out)
}

func posParams(params json.RawMessage) (uri string, line, char int, ok bool) {
	var p struct {
		TextDocument struct {
			URI string `json:"uri"`
		} `json:"textDocument"`
		Position Position `json:"position"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return "", 0, 0, false
	}
	return p.TextDocument.URI, p.Position.Line, p.Position.Character, true
}

func findDefs(name string) []Location {
	type cand struct {
		loc Location
		def bool
	}
	mu.RLock()
	var cands []cand
	for _, syms := range index {
		for _, s := range syms {
			if s.Name == name {
				cands = append(cands, cand{
					loc: Location{URI: s.URI, Range: Range{Position{s.Line, s.Char}, Position{s.EndLine, s.EndChar}}},
					def: s.Def,
				})
			}
		}
	}
	mu.RUnlock()
	// 진짜 정의({/=>)를 선언보다 앞으로. hover 비결정성 해소.
	sort.SliceStable(cands, func(i, j int) bool {
		return cands[i].def && !cands[j].def
	})
	out := make([]Location, 0, len(cands))
	for i, c := range cands {
		if i >= 20 {
			break
		}
		out = append(out, c.loc)
	}
	return out
}

// docText: 열린 버퍼 우선, 없으면 디스크 캐시. 질의 전에 ensureIndexed로 채워둘 것.
func docText(uri string) (string, bool) {
	mu.RLock()
	defer mu.RUnlock()
	if d, ok := docs[uri]; ok {
		return d.Text, true
	}
	if t, ok := fileCache[uri]; ok {
		return t, true
	}
	return "", false
}

func handleDefinition(id *json.RawMessage, params json.RawMessage) {
	uri, line, char, ok := posParams(params)
	if !ok {
		respondErr(id, -32602, "bad params")
		return
	}
	ensureIndexed(uri)
	text, ok := docText(uri)
	if !ok {
		respond(id, []Location{})
		return
	}
	w := wordAt(text, line, char)
	if w == "" {
		respond(id, []Location{})
		return
	}
	locs := findDefs(w)
	if locs == nil {
		locs = []Location{}
	}
	respond(id, locs)
}

func handleReferences(id *json.RawMessage, params json.RawMessage) {
	uri, line, char, ok := posParams(params)
	if !ok {
		respondErr(id, -32602, "bad params")
		return
	}
	ensureIndexed(uri)
	text, ok := docText(uri)
	if !ok {
		respond(id, []Location{})
		return
	}
	w := wordAt(text, line, char)
	if w == "" {
		respond(id, []Location{})
		return
	}
	pat := regexp.MustCompile(`\b` + regexp.QuoteMeta(w) + `\b`)
	// 열린 문서 + 워크스페이스 스캔분(디스크 캐시) 전체에서 검색
	type haystack struct {
		uri  string
		text string
	}
	mu.RLock()
	all := make([]haystack, 0, len(docs)+len(fileCache))
	for u, d := range docs {
		all = append(all, haystack{u, d.Text})
	}
	for u, t := range fileCache {
		if _, open := docs[u]; !open {
			all = append(all, haystack{u, t})
		}
	}
	mu.RUnlock()
	var out []Location
	for _, h := range all {
		lines := strings.Split(h.text, "\n")
		for i, ln := range lines {
			for _, m := range pat.FindAllStringIndex(ln, -1) {
				out = append(out, Location{
					URI:   h.uri,
					Range: Range{Position{i, byteColumnToUTF16(ln, m[0])}, Position{i, byteColumnToUTF16(ln, m[1])}},
				})
				if len(out) >= 200 {
					respond(id, out)
					return
				}
			}
		}
	}
	if out == nil {
		out = []Location{}
	}
	respond(id, out)
}

func handleHover(id *json.RawMessage, params json.RawMessage) {
	uri, line, char, ok := posParams(params)
	if !ok {
		respondErr(id, -32602, "bad params")
		return
	}
	ensureIndexed(uri)
	text, ok := docText(uri)
	if !ok {
		respond(id, nil)
		return
	}
	w := wordAt(text, line, char)
	if w == "" {
		respond(id, nil)
		return
	}
	locs := findDefs(w)
	var md string
	if len(locs) > 0 {
		sig := ""
		if defText, ok := docText(locs[0].URI); ok {
			lines := strings.Split(defText, "\n")
			if locs[0].Range.Start.Line < len(lines) {
				sig = strings.TrimSpace(lines[locs[0].Range.Start.Line])
			}
		}
		md = "```cpp\n" + sig + "\n```\n`" + w + "` — " + locs[0].URI
	} else {
		md = "`" + w + "` (워크스페이스에 정의 없음)"
	}
	respond(id, map[string]interface{}{
		"contents": map[string]interface{}{"kind": "markdown", "value": md},
	})
}

// ---------- main loop ----------

func main() {
	logf("cpp-csharp-lsp-lite %s started (pid=%d)", serverVersion, os.Getpid())
	reader := bufio.NewReader(os.Stdin)
	exiting := false
	for {
		body, err := readMessage(reader)
		if err != nil {
			if err == io.EOF {
				return
			}
			logf("read: %v", err)
			return
		}
		var msg incoming
		if err := json.Unmarshal(body, &msg); err != nil {
			logf("unmarshal: %v", err)
			continue
		}
		switch msg.Method {
		case "initialize":
			handleInitialize(msg.ID, msg.Params)
		case "initialized":
			// no-op
		case "shutdown":
			respond(msg.ID, nil)
			exiting = true
		case "exit":
			return
		case "textDocument/didOpen":
			handleDidOpen(msg.Params)
		case "textDocument/didChange":
			handleDidChange(msg.Params)
		case "textDocument/didClose":
			handleDidClose(msg.Params)
		case "textDocument/documentSymbol":
			handleDocumentSymbol(msg.ID, msg.Params)
		case "workspace/symbol":
			handleWorkspaceSymbol(msg.ID, msg.Params)
		case "textDocument/definition":
			handleDefinition(msg.ID, msg.Params)
		case "textDocument/references":
			handleReferences(msg.ID, msg.Params)
		case "textDocument/hover":
			handleHover(msg.ID, msg.Params)
		case "workspace/didChangeWatchedFiles":
			handleDidChangeWatchedFiles(msg.Params)
		case "$/cancelRequest", "$/setTrace", "workspace/didChangeConfiguration":
			// 무시해도 되는 통지
		default:
			if msg.ID != nil {
				respondErr(msg.ID, -32601, "unsupported: "+msg.Method)
			}
		}
		_ = exiting
	}
}
