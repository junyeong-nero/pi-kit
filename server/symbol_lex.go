package main

import "strings"

// Mask comments and literal contents before signature matching. The result has
// identical byte offsets/newlines, so captured identifiers retain source ranges.
func maskSymbolNonCode(text string) string {
	out := []byte(text)
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
				i = len(text)
			} else {
				i += end + 4
			}
		case strings.HasPrefix(text[i:], `R"`):
			open := strings.IndexByte(text[i+2:], '(')
			if open < 0 || open > 16 {
				i++
				continue
			}
			closing := ")" + text[i+2:i+2+open] + `"`
			body := i + 3 + open
			end := strings.Index(text[body:], closing)
			if end < 0 {
				i = len(text)
			} else {
				i = body + end + len(closing)
			}
		case strings.HasPrefix(text[i:], `@"`):
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
		case text[i] == '"' || text[i] == '\'':
			// A C++ digit separator belongs to a numeric token, not a character literal.
			if text[i] == '\'' && i > 0 && isWordByte(text[i-1]) && i+1 < len(text) && isWordByte(text[i+1]) {
				i++
				continue
			}
			quote := text[i]
			i++
			for i < len(text) {
				b := text[i]
				i++
				if b == '\\' && i < len(text) {
					i++
					continue
				}
				if b == quote {
					break
				}
			}
		default:
			i++
			continue
		}
		for j := start; j < i; j++ {
			if out[j] != '\n' && out[j] != '\r' {
				out[j] = ' '
			}
		}
	}
	return string(out)
}
