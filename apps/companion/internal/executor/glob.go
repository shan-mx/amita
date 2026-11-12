package executor

import (
	"regexp"
	"strings"
)

const globstar = `[^\r\n\x{2028}\x{2029}]*`

// compileGlob uses the Workspace glob syntax for both glob and grep includes.
func compileGlob(pattern string) (*regexp.Regexp, error) {
	var source strings.Builder
	source.WriteByte('^')
	writeGlob(&source, pattern)
	source.WriteByte('$')
	return regexp.Compile(source.String())
}

func writeGlob(source *strings.Builder, pattern string) {
	for i := 0; i < len(pattern); i++ {
		switch pattern[i] {
		case '{':
			parts, end := globAlternatives(pattern, i)
			if len(parts) == 0 {
				source.WriteString(`\{`)
				continue
			}
			source.WriteString("(?:")
			for index, part := range parts {
				if index > 0 {
					source.WriteByte('|')
				}
				writeGlob(source, part)
			}
			source.WriteByte(')')
			i = end
		case '*':
			switch {
			case strings.HasPrefix(pattern[i:], "**/"):
				source.WriteString("(?:" + globstar + "/)?")
				i += 2
			case strings.HasPrefix(pattern[i:], "**"):
				source.WriteString(globstar)
				i++
			default:
				source.WriteString("[^/]*")
			}
		case '?':
			source.WriteString("[^/]")
		default:
			if strings.ContainsRune(`.+^$()[]}|\`, rune(pattern[i])) {
				source.WriteByte('\\')
			}
			source.WriteByte(pattern[i])
		}
	}
}

func globAlternatives(pattern string, open int) ([]string, int) {
	var parts []string
	start, depth := open+1, 0
	for i := start; i < len(pattern); i++ {
		switch pattern[i] {
		case '{':
			depth++
		case '}':
			if depth == 0 {
				if len(parts) == 0 {
					return nil, 0
				}
				return append(parts, pattern[start:i]), i
			}
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, pattern[start:i])
				start = i + 1
			}
		}
	}
	return nil, 0
}
