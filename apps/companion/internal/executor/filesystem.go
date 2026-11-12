package executor

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

const (
	fileWriteChunkBytes    = 512 * 1024
	filesystemDefaultLimit = 100
	filesystemMaxLimit     = 1000
	filesystemMaxEntries   = 10000
	grepDefaultContext     = 2
	grepMaxContext         = 5
	grepMaxMatches         = 500
	grepMaxBytes           = 16 << 20
	grepMaxResponseBytes   = 512 << 10
	grepMaxLineRunes       = 1000
)

type directoryResult struct {
	Entries    []protocol.FileInfo `json:"entries"`
	NextCursor string              `json:"nextCursor,omitempty"`
}
type globResult struct {
	Paths     []string `json:"paths"`
	Truncated bool     `json:"truncated"`
}
type grepMatch struct {
	Path   string   `json:"path"`
	Line   int      `json:"line"`
	Text   string   `json:"text"`
	Before []string `json:"before"`
	After  []string `json:"after"`
}
type grepResult struct {
	Matches   []grepMatch `json:"matches"`
	Truncated bool        `json:"truncated"`
}

func (e *Executor) resolveFilesystemPath(path, cwd string) (string, *protocol.ResultError) {
	if path == "" || strings.IndexByte(path, 0) >= 0 || strings.IndexByte(cwd, 0) >= 0 {
		return "", fail("invalid", "path must be non-empty and contain no NUL bytes", path)
	}
	return e.resolve(path, cwd)
}

func (e *Executor) acquireMutation(path string) *protocol.ResultError {
	if !e.mutationMu.TryLock() {
		return fail("conflict", "Another filesystem mutation is in progress. No changes were written.", path)
	}
	return nil
}
func contextFailure(err error, path string) *protocol.ResultError {
	if errors.Is(err, context.DeadlineExceeded) {
		return fail("timeout", "operation deadline expired", path)
	}
	return fail("aborted", "operation was cancelled", path)
}
func checkContext(ctx context.Context, path string) *protocol.ResultError {
	if err := ctx.Err(); err != nil {
		return contextFailure(err, path)
	}
	return nil
}
func limitArg(p map[string]any, key string, fallback, maximum int) (int, *protocol.ResultError) {
	v, ok := p[key]
	if !ok {
		return fallback, nil
	}
	n, valid := intArg(v)
	if !valid || n < 1 || n > maximum {
		return 0, fail("invalid", fmt.Sprintf("%s must be between 1 and %d", key, maximum), "")
	}
	return n, nil
}
func stringArg(p map[string]any, key string) string { v, _ := p[key].(string); return v }
func validateStringParam(p map[string]any, key string, required bool, path string) *protocol.ResultError {
	v, ok := p[key]
	if !ok {
		if required {
			return fail("invalid", key+" must be a string", path)
		}
		return nil
	}
	if _, ok := v.(string); !ok {
		return fail("invalid", key+" must be a string", path)
	}
	return nil
}
func validateBoolParam(p map[string]any, key, path string) *protocol.ResultError {
	if v, ok := p[key]; ok {
		if _, valid := v.(bool); !valid {
			return fail("invalid", key+" must be a boolean", path)
		}
	}
	return nil
}
func boolArg(p map[string]any, key string, fallback bool) bool {
	v, ok := p[key].(bool)
	if !ok {
		return fallback
	}
	return v
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}
func readContextFile(ctx context.Context, path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	b, readErr := io.ReadAll(contextReader{ctx: ctx, reader: f})
	closeErr := f.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return b, nil
}

func (e *Executor) executeFilesystem(ctx context.Context, method string, p map[string]any) (any, *protocol.ResultError) {
	if method == "absolutePath" {
		path, err := e.resolve(stringArg(p, "path"), stringArg(p, "cwd"))
		if err != nil {
			return nil, err
		}
		return path, nil
	}
	if er := validateStringParam(p, "path", true, ""); er != nil {
		return nil, er
	}
	if er := validateStringParam(p, "cwd", false, stringArg(p, "path")); er != nil {
		return nil, er
	}
	path, er := e.resolveFilesystemPath(stringArg(p, "path"), stringArg(p, "cwd"))
	if er != nil {
		return nil, er
	}
	switch method {
	case "exists":
		_, err := os.Stat(path)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return nil, mapError(err, path)
		}
		return true, nil
	case "fileInfo":
		stat, err := os.Lstat(path)
		if err != nil {
			return nil, mapError(err, path)
		}
		return info(path, stat), nil
	case "writeFile":
		return e.writeFile(ctx, path, p)
	case "listDir":
		return listDirectory(ctx, path, p)
	case "glob":
		return globPaths(ctx, path, p)
	case "grep":
		return grepPath(ctx, path, p)
	case "readTextFile":
		if er := checkContext(ctx, path); er != nil {
			return nil, er
		}
		b, err := readContextFile(ctx, path)
		if ctx.Err() != nil {
			return nil, contextFailure(ctx.Err(), path)
		}
		if err != nil {
			return nil, mapError(err, path)
		}
		return base64.StdEncoding.EncodeToString(b), nil
	case "mkdir":
		if er := validateBoolParam(p, "recursive", path); er != nil {
			return nil, er
		}
		if err := e.acquireMutation(path); err != nil {
			return nil, err
		}
		defer e.mutationMu.Unlock()
		if er := checkContext(ctx, path); er != nil {
			return nil, er
		}
		var err error
		if boolArg(p, "recursive", false) {
			err = os.MkdirAll(path, 0755)
		} else {
			err = os.Mkdir(path, 0755)
		}
		if err != nil {
			return nil, mapError(err, path)
		}
		return nil, nil
	case "remove":
		if er := validateBoolParam(p, "recursive", path); er != nil {
			return nil, er
		}
		if err := e.acquireMutation(path); err != nil {
			return nil, err
		}
		defer e.mutationMu.Unlock()
		if er := checkContext(ctx, path); er != nil {
			return nil, er
		}
		if boolArg(p, "recursive", false) {
			removed, err := removeTree(ctx, path)
			if err != nil {
				result := mapError(err, path)
				if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
					result = contextFailure(err, path)
				}
				if removed {
					result.Message = "The directory was partially deleted. " + result.Message + ". Use fs_list to check what remains before retrying."
				}
				return nil, result
			}
		} else if err := os.Remove(path); err != nil {
			return nil, mapError(err, path)
		}
		return nil, nil
	}
	return nil, fail("not_supported", "execution method is not supported", path)
}

func (e *Executor) writeFile(ctx context.Context, path string, p map[string]any) (any, *protocol.ResultError) {
	content := stringArg(p, "content")
	enc := stringArg(p, "encoding")
	var b []byte
	switch enc {
	case "utf8", "":
		b = []byte(content)
	case "base64":
		decoded, x := base64.StdEncoding.DecodeString(content)
		if x != nil {
			return nil, fail("invalid", "invalid base64 content", path)
		}
		b = decoded
	default:
		return nil, fail("invalid", "encoding must be utf8 or base64", path)
	}
	if er := e.acquireMutation(path); er != nil {
		return nil, er
	}
	defer e.mutationMu.Unlock()
	if er := checkContext(ctx, path); er != nil {
		return nil, er
	}
	if x := os.MkdirAll(filepath.Dir(path), 0777); x != nil {
		return nil, mapError(x, path)
	}
	if er := checkContext(ctx, path); er != nil {
		return nil, er
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0666)
	if err != nil {
		return nil, mapError(err, path)
	}
	defer file.Close()
	for len(b) > 0 {
		if er := checkContext(ctx, path); er != nil {
			return nil, er
		}
		n, err := file.Write(b[:min(len(b), fileWriteChunkBytes)])
		if err != nil {
			return nil, mapError(err, path)
		}
		b = b[n:]
	}
	return nil, nil
}

func listDirectory(ctx context.Context, path string, p map[string]any) (any, *protocol.ResultError) {
	if er := validateStringParam(p, "cursor", false, path); er != nil {
		return nil, er
	}
	limit, er := limitArg(p, "limit", filesystemDefaultLimit, filesystemMaxLimit)
	if er != nil {
		return nil, er
	}
	cursor := stringArg(p, "cursor")
	if strings.IndexByte(cursor, 0) >= 0 {
		return nil, fail("invalid", "cursor contains NUL", path)
	}
	if er := checkContext(ctx, path); er != nil {
		return nil, er
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, mapError(err, path)
	}
	result := directoryResult{Entries: make([]protocol.FileInfo, 0, limit)}
	for _, entry := range entries {
		if er := checkContext(ctx, path); er != nil {
			return nil, er
		}
		if entry.Name() <= cursor {
			continue
		}
		if len(result.Entries) == limit {
			result.NextCursor = result.Entries[len(result.Entries)-1].Name
			break
		}
		st, err := entry.Info()
		if err != nil {
			return nil, mapError(err, filepath.Join(path, entry.Name()))
		}
		result.Entries = append(result.Entries, info(filepath.Join(path, entry.Name()), st))
	}
	return result, nil
}

func globPaths(ctx context.Context, root string, p map[string]any) (any, *protocol.ResultError) {
	if er := validateStringParam(p, "pattern", true, root); er != nil {
		return nil, er
	}
	pattern := stringArg(p, "pattern")
	matcher, err := compileGlob(pattern)
	if err != nil {
		return nil, fail("invalid", err.Error(), root)
	}
	limit, er := limitArg(p, "limit", filesystemDefaultLimit, filesystemMaxLimit)
	if er != nil {
		return nil, er
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, mapError(err, root)
	}
	rootInfo, err := os.Stat(resolvedRoot)
	if err != nil {
		return nil, mapError(err, root)
	}
	if !rootInfo.IsDir() {
		return nil, fail("not_directory", "glob root is not a directory", root)
	}
	paths := make([]string, 0)
	visited := 0
	truncated := false
	err = filepath.WalkDir(resolvedRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if walkErr != nil {
			return walkErr
		}
		if path == resolvedRoot {
			return nil
		}
		visited++
		if visited > filesystemMaxEntries {
			truncated = true
			return errWalkLimit
		}
		rel, err := filepath.Rel(resolvedRoot, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if matcher.MatchString(rel) {
			paths = append(paths, filepath.Join(root, filepath.FromSlash(rel)))
			if len(paths) > limit {
				truncated = true
				return errWalkLimit
			}
		}
		return nil
	})
	if errors.Is(err, errWalkLimit) {
		err = nil
	}
	if ctx.Err() != nil {
		return nil, contextFailure(ctx.Err(), root)
	}
	if err != nil {
		return nil, mapError(err, root)
	}
	if len(paths) > limit {
		paths = paths[:limit]
	}
	return globResult{Paths: paths, Truncated: truncated}, nil
}

var errWalkLimit = errors.New("filesystem traversal limit reached")

func grepPath(ctx context.Context, target string, p map[string]any) (any, *protocol.ResultError) {
	for _, key := range []string{"pattern", "include"} {
		if er := validateStringParam(p, key, key == "pattern", target); er != nil {
			return nil, er
		}
	}
	for _, key := range []string{"literal", "caseSensitive"} {
		if er := validateBoolParam(p, key, target); er != nil {
			return nil, er
		}
	}
	pattern := stringArg(p, "pattern")
	if pattern == "" {
		return nil, fail("invalid", "pattern must be a non-empty string", target)
	}
	literal := boolArg(p, "literal", false)
	caseSensitive := boolArg(p, "caseSensitive", true)
	var re *regexp.Regexp
	needle := pattern
	if literal {
		if !caseSensitive {
			needle = strings.ToLower(needle)
		}
	} else {
		expr := pattern
		if !caseSensitive {
			expr = "(?i)" + expr
		}
		var err error
		re, err = regexp.Compile(expr)
		if err != nil {
			return nil, fail("invalid", "invalid regular expression: "+err.Error(), target)
		}
	}
	contextLines := grepDefaultContext
	if raw, ok := p["context"]; ok {
		n, valid := intArg(raw)
		if !valid || n < 0 || n > grepMaxContext {
			return nil, fail("invalid", fmt.Sprintf("context must be between 0 and %d", grepMaxContext), target)
		}
		contextLines = n
	}
	limit := filesystemDefaultLimit
	if raw, ok := p["limit"]; ok {
		n, valid := intArg(raw)
		if !valid || n < 1 || n > grepMaxMatches {
			return nil, fail("invalid", fmt.Sprintf("limit must be between 1 and %d", grepMaxMatches), target)
		}
		limit = n
	}
	var include *regexp.Regexp
	if pattern := stringArg(p, "include"); pattern != "" {
		var err error
		include, err = compileGlob(pattern)
		if err != nil {
			return nil, fail("invalid", err.Error(), target)
		}
	}
	st, err := os.Stat(target)
	if err != nil {
		return nil, mapError(err, target)
	}
	files := []string{}
	entriesTruncated := false
	if st.IsDir() {
		walkRoot, err := filepath.EvalSymlinks(target)
		if err != nil {
			return nil, mapError(err, target)
		}
		visited := 0
		err = filepath.WalkDir(walkRoot, func(path string, d fs.DirEntry, walkErr error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if walkErr != nil {
				return walkErr
			}
			if path == walkRoot {
				return nil
			}
			visited++
			if visited > filesystemMaxEntries {
				entriesTruncated = true
				return errWalkLimit
			}
			if d.IsDir() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			if info.Mode().IsRegular() {
				rel, err := filepath.Rel(walkRoot, path)
				if err != nil {
					return err
				}
				if include != nil && !include.MatchString(filepath.ToSlash(rel)) {
					return nil
				}
				files = append(files, filepath.Join(target, rel))
			}
			return nil
		})
		if ctx.Err() != nil {
			return nil, contextFailure(ctx.Err(), target)
		}
		if err != nil && !errors.Is(err, errWalkLimit) {
			return nil, mapError(err, target)
		}
	} else if st.Mode().IsRegular() {
		files = append(files, target)
	} else {
		return nil, fail("invalid", "grep requires a regular file or directory", target)
	}
	result := grepResult{Matches: []grepMatch{}}
	totalBytes := 0
	for _, path := range files {
		if er := checkContext(ctx, path); er != nil {
			return nil, er
		}
		if totalBytes >= grepMaxBytes {
			result.Truncated = true
			break
		}
		remaining := grepMaxBytes - totalBytes
		file, err := os.Open(path)
		if err != nil {
			return nil, mapError(err, path)
		}
		data, readErr := io.ReadAll(io.LimitReader(contextReader{ctx: ctx, reader: file}, int64(remaining+1)))
		closeErr := file.Close()
		if readErr != nil {
			if ctx.Err() != nil {
				return nil, contextFailure(ctx.Err(), path)
			}
			return nil, mapError(readErr, path)
		}
		if closeErr != nil {
			return nil, mapError(closeErr, path)
		}
		totalBytes += len(data)
		if totalBytes > grepMaxBytes {
			result.Truncated = true
			break
		}
		text := strings.ToValidUTF8(strings.TrimPrefix(string(data), "\uFEFF"), "\uFFFD")
		lines := strings.Split(text, "\n")
		if lines[len(lines)-1] == "" {
			lines = lines[:len(lines)-1]
		}
		for i, line := range lines {
			if er := checkContext(ctx, path); er != nil {
				return nil, er
			}
			found := false
			if literal {
				candidate := line
				search := needle
				if !caseSensitive {
					candidate = strings.ToLower(candidate)
				}
				found = strings.Contains(candidate, search)
			} else {
				found = re.MatchString(line)
			}
			if !found {
				continue
			}
			match := grepMatch{Path: path, Line: i + 1, Text: truncateRunes(line, grepMaxLineRunes), Before: contextSlice(lines, max(0, i-contextLines), i), After: contextSlice(lines, i+1, min(len(lines), i+1+contextLines))}
			encoded, _ := json.Marshal(match)
			current, _ := json.Marshal(result.Matches)
			if len(result.Matches) >= limit || len(current)+len(encoded)+2 > grepMaxResponseBytes {
				result.Truncated = true
				break
			}
			result.Matches = append(result.Matches, match)
		}
		if result.Truncated {
			break
		}
	}
	result.Truncated = result.Truncated || entriesTruncated
	return result, nil
}
func truncateRunes(s string, maxRunes int) string {
	r := []rune(s)
	if len(r) > maxRunes {
		return string(r[:maxRunes])
	}
	return s
}
func contextSlice(lines []string, start, end int) []string {
	if start >= end {
		return []string{}
	}
	out := make([]string, 0, end-start)
	for _, line := range lines[start:end] {
		out = append(out, truncateRunes(line, grepMaxLineRunes))
	}
	return out
}
func removeTree(ctx context.Context, path string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		err := os.Remove(path)
		return err == nil, err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, err
	}
	removed := false
	for _, entry := range entries {
		childRemoved, err := removeTree(ctx, filepath.Join(path, entry.Name()))
		removed = removed || childRemoved
		if err != nil {
			return removed, err
		}
	}
	if err := ctx.Err(); err != nil {
		return removed, err
	}
	err = os.Remove(path)
	return removed || err == nil, err
}
