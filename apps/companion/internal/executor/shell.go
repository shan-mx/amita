package executor

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

func (e *Executor) runShell(parent context.Context, p map[string]any, id string, emit Emit) (any, *protocol.ResultError) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	var c *exec.Cmd
	switch v := p["command"].(type) {
	case string:
		c = exec.CommandContext(ctx, "/bin/bash", "-c", v)
	case []any:
		if len(v) == 0 {
			return nil, fail("invalid", "argv must not be empty", "")
		}
		argv := make([]string, 0, len(v))
		for _, a := range v {
			s, ok := a.(string)
			if !ok {
				return nil, fail("invalid", "argv entries must be strings", "")
			}
			argv = append(argv, s)
		}
		c = exec.CommandContext(ctx, argv[0], argv[1:]...)
	default:
		return nil, fail("invalid", "command must be a string or argv", "")
	}
	if err := prepareProcess(c); err != nil {
		return nil, fail("not_supported", err.Error(), "")
	}
	c.Cancel = func() error { return killProcessGroup(c) }
	c.WaitDelay = 2 * time.Second
	cwd, _ := p["cwd"].(string)
	if cwd != "" {
		c.Dir = cwd
	}
	inherit, inheritSet := p["inheritEnv"].(bool)
	if inheritSet && inherit {
		c.Env = os.Environ()
	} else {
		c.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" + e.Home}
	}
	if env, ok := p["env"].(map[string]any); ok {
		for k, v := range env {
			if s, ok := v.(string); ok {
				c.Env = append(c.Env, k+"="+s)
			}
		}
	}
	out, err := c.StdoutPipe()
	if err != nil {
		return nil, fail("spawn_error", err.Error(), "")
	}
	stderr, err := c.StderrPipe()
	if err != nil {
		return nil, fail("spawn_error", err.Error(), "")
	}
	if err = c.Start(); err != nil {
		return nil, fail("spawn_error", err.Error(), "")
	}
	startedAt := time.Now()
	var timedOut atomic.Bool
	var timeoutTimer *time.Timer
	nativeTimeout, hasNativeTimeout := durationFromSeconds(p["timeout"])
	if hasNativeTimeout {
		timeoutTimer = time.AfterFunc(nativeTimeout, func() { timedOut.Store(true); cancel() })
		defer timeoutTimer.Stop()
	}
	chunks := make(chan outputChunk, 16)
	var readers sync.WaitGroup
	read := func(stream string, r io.Reader) {
		defer readers.Done()
		buf := make([]byte, 32768)
		pending := []byte(nil)
		for {
			n, er := r.Read(buf)
			if n > 0 {
				pending = append(pending, buf[:n]...)
				// Emit only complete UTF-8 prefixes. Invalid bytes are replaced consistently.
				prefix := completeUTF8Prefix(pending)
				if prefix > 0 {
					chunks <- outputChunk{stream, string(pending[:prefix])}
					pending = append([]byte(nil), pending[prefix:]...)
				}
			}
			if er != nil {
				if len(pending) > 0 {
					chunks <- outputChunk{stream, strings.ToValidUTF8(string(pending), "�")}
				}
				return
			}
		}
	}
	spillAfterBytes, spillAfterLines := int64(0), int64(0)
	if spill, ok := p["spill"].(map[string]any); ok {
		spillAfterBytes, _ = int64Arg(spill["afterBytes"])
		spillAfterLines, _ = int64Arg(spill["afterLines"])
	}
	var spillFile *os.File
	var spillPath string
	var spillPrefix strings.Builder
	var spillNewlines int64
	window := parseOutputWindow(p["window"])
	retained := outputTail{}
	var lastOutput time.Time
	var lastSnapshot protocol.Output
	hasSnapshot := false
	appendSpill := func(text string) error {
		if text == "" || (spillAfterBytes <= 0 && spillAfterLines <= 0) {
			return nil
		}
		if spillFile != nil {
			_, err := spillFile.WriteString(text)
			return err
		}

		spillNewlines += int64(strings.Count(text, "\n"))
		lines := spillNewlines
		if !strings.HasSuffix(text, "\n") {
			lines++
		}
		bytesExceeded := spillAfterBytes > 0 && int64(spillPrefix.Len())+int64(len(text)) > spillAfterBytes
		linesExceeded := spillAfterLines > 0 && lines > spillAfterLines
		if !bytesExceeded && !linesExceeded {
			spillPrefix.WriteString(text)
			return nil
		}

		dir := filepath.Join(e.StateDir, "spill")
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		if err := os.Chmod(dir, 0700); err != nil {
			return err
		}
		file, err := os.CreateTemp(dir, "amita-output-*.log")
		if err != nil {
			return err
		}
		spillFile = file
		if _, err := spillFile.WriteString(spillPrefix.String()); err != nil {
			return err
		}
		spillPrefix.Reset()
		if _, err := spillFile.WriteString(text); err != nil {
			return err
		}
		spillPath = spillFile.Name()
		return nil
	}
	readers.Add(2)
	go read("stdout", out)
	go read("stderr", stderr)
	go func() { readers.Wait(); close(chunks) }()
	readErr := error(nil)
	tickEvery := window.minInterval
	if tickEvery < time.Millisecond {
		tickEvery = time.Millisecond
	}
	ticker := time.NewTicker(tickEvery)
	defer ticker.Stop()
	emitSnapshot := func(now time.Time, terminal bool) {
		if retained.text == "" {
			return
		}
		current := protocol.Output{ID: id, Stream: retained.stream, Text: retained.text, Snapshot: true, Before: retained.before}
		changed := !hasSnapshot || current.Text != lastSnapshot.Text || current.Stream != lastSnapshot.Stream || current.Before != lastSnapshot.Before
		if !changed {
			return
		}
		minGap := window.minInterval
		if window.bytesPerSecond > 0 {
			minGap += time.Duration(float64(len(current.Text)) / window.bytesPerSecond * float64(time.Second))
		}
		if !terminal && !lastOutput.IsZero() && now.Sub(lastOutput) < minGap {
			return
		}
		if err := emit(current); err != nil && readErr == nil {
			readErr = err
			_ = killProcessGroup(c)
			cancel()
		}
		lastOutput = now
		lastSnapshot = current
		hasSnapshot = true
	}
	for {
		select {
		case ch, ok := <-chunks:
			if !ok {
				goto outputDone
			}
			if readErr == nil {
				if err := appendSpill(ch.text); err != nil {
					readErr = err
					_ = killProcessGroup(c)
					cancel()
				}
			}
			retained.add(ch.stream, ch.text, window)
			emitSnapshot(time.Now(), false)
		case now := <-ticker.C:
			emitSnapshot(now, false)
		}
	}
outputDone:
	emitSnapshot(time.Now(), true)
	waitErr := c.Wait()
	if spillFile != nil {
		if err := spillFile.Sync(); err != nil && readErr == nil {
			readErr = err
		}
		if err := spillFile.Close(); err != nil && readErr == nil {
			readErr = err
		}
		if spillPath == "" {
			_ = os.Remove(spillFile.Name())
		}
	}
	if readErr != nil {
		return nil, fail("unknown", "could not persist or deliver command output: "+readErr.Error(), "")
	}
	if timedOut.Load() || (hasNativeTimeout && (time.Since(startedAt) >= nativeTimeout || errors.Is(parent.Err(), context.DeadlineExceeded))) {
		return nil, &protocol.ResultError{
			Code:      "timeout",
			Message:   "command timed out",
			SpillPath: spillPath,
		}
	}
	if errors.Is(parent.Err(), context.DeadlineExceeded) {
		return nil, &protocol.ResultError{Code: "unknown", Message: "operation deadline expired", SpillPath: spillPath}
	}
	if parent.Err() != nil {
		return nil, &protocol.ResultError{Code: "aborted", Message: "command was cancelled", SpillPath: spillPath}
	}
	if waitErr != nil {
		var x *exec.ExitError
		if errors.As(waitErr, &x) {
			return shellValue(x.ExitCode(), spillPath), nil
		}
		return nil, &protocol.ResultError{Code: "unknown", Message: waitErr.Error(), SpillPath: spillPath}
	}
	return shellValue(0, spillPath), nil
}

func shellValue(exitCode int, spillPath string) map[string]any {
	value := map[string]any{"exitCode": exitCode}
	if spillPath != "" {
		value["spillPath"] = spillPath
	}
	return value
}

func optionalPath(p string) any {
	if p == "" {
		return nil
	}
	return p
}
func completeUTF8Prefix(b []byte) int {
	for i := 0; i < len(b); {
		if !utf8.FullRune(b[i:]) {
			return i
		}
		_, n := utf8.DecodeRune(b[i:])
		if n == 0 {
			return i
		}
		i += n
	}
	return len(b)
}

type outputWindow struct {
	maxBytes       int
	maxLines       int
	minInterval    time.Duration
	bytesPerSecond float64
}

func parseOutputWindow(v any) outputWindow {
	w := outputWindow{maxBytes: protocol.DefaultOutputMaxBytes, maxLines: 2000, minInterval: 100 * time.Millisecond, bytesPerSecond: 64 * 1024}
	m, _ := v.(map[string]any)
	if n, ok := int64Arg(m["maxBytes"]); ok && n > 0 {
		w.maxBytes = int(n)
	}
	if n, ok := int64Arg(m["maxLines"]); ok && n > 0 {
		w.maxLines = int(n)
	}
	if n, ok := int64Arg(m["minIntervalMs"]); ok && n >= 0 {
		w.minInterval = time.Duration(n) * time.Millisecond
	}
	if n, ok := int64Arg(m["bytesPerSecond"]); ok && n > 0 {
		w.bytesPerSecond = float64(n)
	}
	return w
}

type outputTail struct {
	text   string
	stream string
	before protocol.OutputBoundary
}

func (t *outputTail) add(stream, chunk string, w outputWindow) {
	t.text += chunk
	if chunk != "" {
		t.stream = stream
	}
	byteCap := w.maxBytes + utf8.UTFMax
	if cut := len(t.text) - byteCap; cut > 0 {
		for cut < len(t.text) && (t.text[cut]&0xc0) == 0x80 {
			cut++
		}
		t.discard(cut)
	}
	lineCap := w.maxLines + 1
	newlines := strings.Count(t.text, "\n")
	if excess := newlines - lineCap; excess > 0 {
		cut := 0
		for i := 0; i < excess; i++ {
			at := strings.IndexByte(t.text[cut:], '\n')
			if at < 0 {
				break
			}
			cut += at + 1
		}
		t.discard(cut)
	}
}

func (t *outputTail) discard(n int) {
	if n <= 0 {
		return
	}
	if n > len(t.text) {
		n = len(t.text)
	}
	prefix := t.text[:n]
	t.before.Bytes += int64(len(prefix))
	t.before.Newlines += int64(strings.Count(prefix, "\n"))
	t.before.EndsWithNewline = prefix[len(prefix)-1] == '\n'
	t.text = t.text[n:]
}
