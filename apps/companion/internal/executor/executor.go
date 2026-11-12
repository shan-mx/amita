package executor

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

type Emit func(protocol.Output) error
type Executor struct {
	Home, StateDir string
	mu             sync.Mutex
	mutationMu     sync.Mutex
	readers        map[string]*os.File
}

func New(home, state string) *Executor {
	return &Executor{Home: home, StateDir: state, readers: map[string]*os.File{}}
}
func (e *Executor) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	for k, f := range e.readers {
		_ = f.Close()
		delete(e.readers, k)
	}
}

func (e *Executor) EnsureWorkspace(ctx context.Context, path string) *protocol.ResultError {
	_, err := e.executeFilesystem(ctx, "mkdir", map[string]any{"path": path, "recursive": true})
	return err
}

func (e *Executor) Execute(ctx context.Context, method string, raw json.RawMessage, id string, emit Emit) (any, *protocol.ResultError) {
	if emit == nil {
		emit = func(protocol.Output) error { return nil }
	}
	if er := checkContext(ctx, ""); er != nil {
		return nil, er
	}
	if method == protocol.ReaderScanLines {
		return e.scanReaderLines(ctx, raw)
	}
	var p map[string]any
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fail("invalid", err.Error(), "")
	}
	switch method {
	case "exec":
		return e.runShell(ctx, p, id, emit)
	case "openBinaryReader", "readerInfo", "readerRead", "readerClose":
		return e.executeReader(ctx, method, p, id)
	case "absolutePath", "exists", "fileInfo", "readTextFile",
		"writeFile", "listDir", "glob", "grep", "mkdir", "remove":
		return e.executeFilesystem(ctx, method, p)
	default:
		return nil, fail("not_supported", "execution method is not supported", "")
	}
}

func (e *Executor) executeReader(ctx context.Context, method string, p map[string]any, id string) (any, *protocol.ResultError) {
	switch method {
	case "openBinaryReader":
		v, er := e.resolve(stringArg(p, "path"), stringArg(p, "cwd"))
		if er != nil {
			return nil, er
		}
		flags := os.O_RDONLY
		if noFollow, _ := p["noFollow"].(bool); noFollow {
			flags |= syscall.O_NOFOLLOW
		}
		f, x := os.OpenFile(v, flags, 0)
		if x != nil {
			return nil, mapError(x, v)
		}
		st, x := f.Stat()
		if x != nil {
			_ = f.Close()
			return nil, mapError(x, v)
		}
		if !st.Mode().IsRegular() {
			_ = f.Close()
			return nil, fail("invalid", "reader requires a regular file", v)
		}
		handle := id
		e.mu.Lock()
		defer e.mu.Unlock()
		if err := checkContext(ctx, v); err != nil {
			_ = f.Close()
			return nil, err
		}
		if _, exists := e.readers[handle]; exists {
			_ = f.Close()
			return nil, fail("unknown", "reader handle collision", v)
		}
		e.readers[handle] = f
		return handle, nil
	case "readerInfo", "readerRead":
		f := e.reader(stringArg(p, "handle"))
		if f == nil {
			return nil, fail("reader_expired", "The file read was interrupted. Call fs_read again on the same path.", "")
		}
		if method == "readerInfo" {
			st, x := f.Stat()
			if x != nil {
				return nil, mapError(x, "")
			}
			return info(f.Name(), st), nil
		}
		off, ok := int64Arg(p["offset"])
		if !ok || off < 0 {
			return nil, fail("invalid", "offset must be a non-negative integer", "")
		}
		n, ok := intArg(p["length"])
		if !ok || n < 0 || n > 1024*1024 {
			return nil, fail("invalid", "length must be between 0 and 1048576", "")
		}
		b := make([]byte, n)
		count, x := f.ReadAt(b, off)
		if x != nil && x != io.EOF {
			return nil, mapError(x, "")
		}
		return base64.StdEncoding.EncodeToString(b[:count]), nil
	case "readerClose":
		e.mu.Lock()
		if f := e.readers[stringArg(p, "handle")]; f != nil {
			_ = f.Close()
			delete(e.readers, stringArg(p, "handle"))
		}
		e.mu.Unlock()
		return nil, nil
	default:
		return nil, fail("not_supported", "reader method is not supported", "")
	}
}

func (e *Executor) resolve(p, cwd string) (string, *protocol.ResultError) {
	if strings.HasPrefix(p, "~") {
		if p == "~" {
			p = e.Home
		} else if strings.HasPrefix(p, "~/") {
			p = filepath.Join(e.Home, p[2:])
		}
	}
	if !filepath.IsAbs(p) {
		if cwd == "" {
			cwd = e.Home
		}
		if !filepath.IsAbs(cwd) {
			return "", fail("invalid", "cwd must be absolute", cwd)
		}
		p = filepath.Join(cwd, p)
	}
	a, err := filepath.Abs(filepath.Clean(p))
	if err != nil {
		return "", mapError(err, p)
	}
	return a, nil
}
func (e *Executor) reader(id string) *os.File { e.mu.Lock(); defer e.mu.Unlock(); return e.readers[id] }
func info(path string, st os.FileInfo) protocol.FileInfo {
	kind := "file"
	if st.Mode()&os.ModeSymlink != 0 {
		kind = "symlink"
	} else if st.IsDir() {
		kind = "directory"
	}
	return protocol.FileInfo{Name: filepath.Base(path), Path: path, Kind: kind, Size: st.Size(), MtimeMs: st.ModTime().UnixMilli()}
}
func fail(c, m, p string) *protocol.ResultError {
	return &protocol.ResultError{Code: c, Message: m, Path: p}
}
func mapError(err error, path string) *protocol.ResultError {
	c := "unknown"
	switch {
	case errors.Is(err, os.ErrNotExist):
		c = "not_found"
	case errors.Is(err, os.ErrPermission):
		c = "permission_denied"
	case errors.Is(err, syscall.ENOTDIR):
		c = "not_directory"
	case errors.Is(err, syscall.EISDIR):
		c = "is_directory"
	case errors.Is(err, syscall.EINVAL):
		c = "invalid"
	case errors.Is(err, syscall.ELOOP):
		c = "invalid"
	case errors.Is(err, syscall.ENOTEMPTY):
		c = "not_empty"
	case errors.Is(err, syscall.EEXIST):
		c = "conflict"
	}
	return fail(c, err.Error(), path)
}
func int64Arg(x any) (int64, bool) {
	switch v := x.(type) {
	case float64:
		return int64(v), v == float64(int64(v))
	case json.Number:
		n, e := v.Int64()
		return n, e == nil
	}
	return 0, false
}
func intArg(x any) (int, bool) { n, ok := int64Arg(x); return int(n), ok && int64(int(n)) == n }

type outputChunk struct{ stream, text string }
type spillOptions struct{ afterBytes, afterLines int64 }

// durationFromSeconds accepts integral or fractional native timeout values.
func durationFromSeconds(v any) (time.Duration, bool) {
	x, ok := v.(float64)
	if !ok || x <= 0 {
		return 0, false
	}
	return time.Duration(x * float64(time.Second)), true
}
