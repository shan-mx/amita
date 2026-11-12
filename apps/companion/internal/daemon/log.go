package daemon

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/shan-mx/amita/apps/companion/internal/config"
)

const (
	logMaxBytes     = 4 * 1024 * 1024
	logBackups      = 3
	DefaultLogLines = 50
)

type rotatingLog struct {
	mu       sync.Mutex
	file     *os.File
	path     string
	size     int64
	maxBytes int64
}

func LogPath(state string) string { return filepath.Join(state, "companion.log") }
func openLog(state string) (*rotatingLog, error) {
	if err := config.EnsureDir(state); err != nil {
		return nil, err
	}
	path := LogPath(state)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	stat, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	return &rotatingLog{file: f, path: path, size: stat.Size(), maxBytes: logMaxBytes}, nil
}
func (l *rotatingLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.size > 0 && l.size+int64(len(p)) > l.maxBytes {
		if err := l.file.Close(); err != nil {
			return 0, err
		}
		for i := logBackups; i > 0; i-- {
			source := l.path
			if i > 1 {
				source += "." + strconv.Itoa(i-1)
			}
			if err := os.Rename(source, l.path+"."+strconv.Itoa(i)); err != nil && !os.IsNotExist(err) {
				return 0, err
			}
		}
		f, err := os.OpenFile(l.path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if err != nil {
			return 0, err
		}
		l.file = f
		l.size = 0
	}
	n, err := l.file.Write(p)
	l.size += int64(n)
	return n, err
}
func (l *rotatingLog) Close() error { l.mu.Lock(); defer l.mu.Unlock(); return l.file.Close() }

func Logs(ctx context.Context, state string, lines int, follow bool, out io.Writer) error {
	if lines < 0 {
		return fmt.Errorf("log line count must not be negative")
	}
	path := LogPath(state)
	if _, err := fmt.Fprintf(out, "Log file: %s\n", path); err != nil {
		return err
	}
	if _, err := os.Stat(path); err != nil {
		return err
	}
	args := []string{"-n", strconv.Itoa(lines)}
	if follow {
		args = append(args, "-F")
	}
	args = append(args, path)
	cmd := exec.CommandContext(ctx, "tail", args...)
	cmd.Stdout = out
	cmd.Stderr = out
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil
	}
	return err
}
