package main

import "strings"

// Replace comments/literals with spaces while preserving byte offsets and lines.
// Interpolation expressions need a full language lexer; decline bracket checking
// for these documents rather than report errors on valid embedded expressions.
func maskDiagnosticLiterals(text, language string) (string, bool) {
	out := []byte(text)
	blank := func(start, end int) {
		for j := start; j < end; j++ {
			if out[j] != '\n' && out[j] != '\r' {
				out[j] = ' '
			}
		}
	}
	for i := 0; i < len(text); {
		start := i
		switch {
		case strings.HasPrefix(text[i:], "//"):
			for i < len(text) && text[i] != '\n' {
				i++
			}
		case strings.HasPrefix(text[i:], "/*"):
			end := strings.Index(text[i+2:], "*/")
			if end < 0 {
				return "", false
			}
			i += end + 4
		case text[i] == '$' && i+1 < len(text) && strings.ContainsAny(text[i+1:i+2], "$@\""):
			return "", false
		case strings.HasPrefix(text[i:], "@$\""):
			return "", false
		case strings.HasPrefix(text[i:], "R\""):
			// C++ raw literals, including u8R/LR prefixes (visited at R).
			open := strings.IndexByte(text[i+2:], '(')
			if open < 0 || open > 16 {
				return "", false
			}
			delim := text[i+2 : i+2+open]
			close := ")" + delim + "\""
			body := i + 3 + open
			end := strings.Index(text[body:], close)
			if end < 0 {
				return "", false
			}
			i = body + end + len(close)
		case strings.HasPrefix(text[i:], "@\""):
			i += 2
			for i < len(text) {
				if text[i] == '"' {
					i++
					if i >= len(text) || text[i] != '"' {
						break
					}
				}
				i++
			}
		case (language == "csharp" || language == "cs") && strings.HasPrefix(text[i:], "\"\"\""):
			// C# raw delimiters consist of three or more quotes.
			for i < len(text) && text[i] == '"' {
				i++
			}
			end := strings.Index(text[i:], text[start:i])
			if end < 0 {
				return "", false
			}
			i += end + (i - start)
		case text[i] == '"' || text[i] == '\'':
			quote := text[i]
			i++
			for i < len(text) {
				if text[i] == '\\' {
					i++ // Consume escape pairs, including escaped backslashes.
					if i < len(text) {
						i++
					}
					continue
				}
				b := text[i]
				i++
				if b == quote {
					break
				}
			}
		default:
			i++
			continue
		}
		blank(start, i)
	}
	return string(out), true
}
