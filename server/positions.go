package main

import "strings"

// LSP defaults to UTF-16. Internally the lexer and Go regular expressions use
// byte offsets; convert only when accepting a position or publishing a range.
func byteColumnToUTF16(line string, column int) int {
	units := 0
	for offset, r := range line {
		if offset >= column {
			break
		}
		units++
		if r > 0xffff {
			units++
		}
	}
	return units
}

func utf16ColumnToByte(line string, column int) (int, bool) {
	if column < 0 {
		return 0, false
	}
	units := 0
	for offset, r := range line {
		if units == column {
			return offset, true
		}
		units++
		if r > 0xffff {
			units++
		}
		if units > column {
			// A position within a surrogate pair is not a character boundary.
			return 0, false
		}
	}
	// LSP positions past the line's end are clamped to the line length.
	return len(line), true
}

func builtinDiags(text string, language ...string) []Diag {
	diags := builtinByteDiags(text, language...)
	if len(diags) == 0 {
		return diags
	}
	lines := strings.Split(text, "\n")
	for i := range diags {
		start := &diags[i].Range.Start
		end := &diags[i].Range.End
		start.Character = byteColumnToUTF16(lines[start.Line], start.Character)
		end.Character = byteColumnToUTF16(lines[end.Line], end.Character)
	}
	return diags
}
