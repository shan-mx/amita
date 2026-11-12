package executor

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

func run(t *testing.T, e *Executor, method string, p string, id string, emit Emit) (any, string) {
	t.Helper()
	v, err := e.Execute(context.Background(), method, json.RawMessage(p), id, emit)
	if err != nil {
		return v, err.Code + ":" + err.Message
	}
	return v, ""
}

func TestReaderUsesStableDescriptorAndExactPositionalBytes(t *testing.T) {
	dir := t.TempDir()
	home := dir
	state := filepath.Join(dir, "state")
	e := New(home, state)
	defer e.Close()
	path := filepath.Join(dir, "source.bin")
	data := []byte("A世界\x00Z")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	v, errText := run(t, e, "openBinaryReader", `{"path":"`+path+`"}`, "open-id", nil)
	if errText != "" {
		t.Fatal(errText)
	}
	handle := v.(string)
	renamed := filepath.Join(dir, "renamed.bin")
	if err := os.Rename(path, renamed); err != nil {
		t.Fatal(err)
	}
	v, errText = run(t, e, "readerRead", `{"handle":"`+handle+`","offset":1,"length":6}`, "read-id", nil)
	if errText != "" {
		t.Fatal(errText)
	}
	got, err := base64.StdEncoding.DecodeString(v.(string))
	if err != nil {
		t.Fatal(err)
	}
	want := data[1:7]
	if string(got) != string(want) {
		t.Fatalf("read bytes %q, want %q", got, want)
	}
	v, errText = run(t, e, "readerInfo", `{"handle":"`+handle+`"}`, "info-id", nil)
	if errText != "" {
		t.Fatal(errText)
	}
	if v.(protocol.FileInfo).Path != path {
		t.Fatalf("reader path = %#v", v)
	}
	if _, errText := run(t, e, "readerClose", `{"handle":"`+handle+`"}`, "close-id", nil); errText != "" {
		t.Fatal(errText)
	}
	_, errText = run(t, e, "readerRead", `{"handle":"`+handle+`","offset":0,"length":1}`, "expired-read-id", nil)
	if !strings.HasPrefix(errText, "reader_expired:") || !strings.Contains(errText, "fs_read again on the same path") {
		t.Fatalf("expired read error = %q", errText)
	}
}

func TestExecStreamsBothChannelsBeforeCompletion(t *testing.T) {
	e := New(t.TempDir(), t.TempDir())
	defer e.Close()
	var chunks []string
	started := time.Now()
	firstOutput := time.Duration(-1)
	v, errText := run(t, e, "exec", `{"command":"printf 'first'; printf 'problem' >&2; sleep 0.25; printf 'last'","inheritEnv":true}`, "stream-id", func(o protocol.Output) error {
		if firstOutput < 0 {
			firstOutput = time.Since(started)
		}
		chunks = append(chunks, o.Stream+":"+o.Text)
		return nil
	})
	if errText != "" {
		t.Fatal(errText)
	}
	if time.Since(started) < 200*time.Millisecond {
		t.Fatal("command did not wait for its delayed final output")
	}
	if firstOutput < 0 || firstOutput >= 200*time.Millisecond {
		t.Fatalf("first output arrived after %v", firstOutput)
	}
	if len(chunks) < 2 || !strings.Contains(chunks[len(chunks)-1], "first") || !strings.Contains(chunks[len(chunks)-1], "problem") || !strings.Contains(chunks[len(chunks)-1], "last") {
		t.Fatalf("cumulative stream snapshots = %#v", chunks)
	}
	if v.(map[string]any)["exitCode"] != 0 {
		t.Fatalf("result = %#v", v)
	}
}

func TestExecCancellationKillsProcessGroup(t *testing.T) {
	e := New(t.TempDir(), t.TempDir())
	defer e.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan string, 1)
	childPID := make(chan int, 1)
	go func() {
		_, er := e.Execute(ctx, "exec", json.RawMessage(`{"command":["/bin/bash","-c","sleep 30 & echo $!; wait"],"inheritEnv":true}`), "cancel-id", func(o protocol.Output) error {
			if strings.TrimSpace(o.Text) != "" {
				if n, err := strconv.Atoi(strings.TrimSpace(o.Text)); err == nil {
					childPID <- n
				}
			}
			return nil
		})
		if er == nil {
			done <- ""
		} else {
			done <- er.Code
		}
	}()
	var pid int
	select {
	case pid = <-childPID:
	case <-time.After(3 * time.Second):
		t.Fatal("child PID was not streamed")
	}
	cancel()
	select {
	case code := <-done:
		if code != "aborted" {
			t.Fatalf("cancel result code = %q", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not stop shell")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		err := syscall.Kill(pid, 0)
		if err == syscall.ESRCH {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("child process %d survived cancellation", pid)
}

func TestExecCancellationRemainsActiveAfterPipesClose(t *testing.T) {
	e := New(t.TempDir(), t.TempDir())
	defer e.Close()
	pidPath := filepath.Join(t.TempDir(), "child.pid")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan *protocol.ResultError, 1)
	command := "echo $$ > '" + pidPath + "'; exec sleep 120 >/dev/null 2>&1"
	go func() {
		_, resultErr := e.Execute(ctx, "exec", json.RawMessage(mustJSON(map[string]any{"command": command, "inheritEnv": true})), "closed-pipes", nil)
		done <- resultErr
	}()
	deadline := time.Now().Add(2 * time.Second)
	var pid int
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(pidPath); err == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(b)))
			if pid > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if pid == 0 {
		cancel()
		t.Fatal("shell did not start")
	}
	cancel()
	select {
	case resultErr := <-done:
		if resultErr == nil || resultErr.Code != "aborted" {
			t.Fatalf("cancellation result = %#v", resultErr)
		}
	case <-time.After(300 * time.Millisecond):
		_ = syscall.Kill(-pid, syscall.SIGKILL) // Keep the regression test from leaving the old implementation's process behind.
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		t.Fatal("command remained in Wait after both output pipes closed")
	}
	if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
		t.Fatalf("closed-pipe process %d survived cancellation: %v", pid, err)
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func TestExecNativeTimeoutKillsProcessGroup(t *testing.T) {
	e := New(t.TempDir(), t.TempDir())
	defer e.Close()
	pid := 0
	_, errText := run(t, e, "exec", `{"command":["/bin/bash","-c","sleep 30 & echo $!; wait"],"inheritEnv":true,"timeout":0.15}`, "timeout-id", func(o protocol.Output) error {
		if n, err := strconv.Atoi(strings.TrimSpace(o.Text)); err == nil {
			pid = n
		}
		return nil
	})
	if !strings.HasPrefix(errText, "timeout:") {
		t.Fatalf("timeout result = %q", errText)
	}
	if pid == 0 {
		t.Fatal("child PID was not streamed")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("child process %d survived native timeout", pid)
}

func TestExecCanFinishAtThresholdWithoutSpillStorage(t *testing.T) {
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "spill"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	e := New(t.TempDir(), state)
	defer e.Close()

	value, errText := run(t, e, "exec", `{"command":"printf 'short'","spill":{"afterBytes":5,"afterLines":1}}`, "no-spill", nil)
	if errText != "" {
		t.Fatal(errText)
	}
	result := value.(map[string]any)
	if result["exitCode"] != 0 || result["spillPath"] != nil {
		t.Fatalf("short command result = %#v", result)
	}
}

func TestExecSpillsCompleteCombinedOutputWhenThresholdCrossed(t *testing.T) {
	state := t.TempDir()
	e := New(t.TempDir(), state)
	defer e.Close()
	v, errText := run(t, e, "exec", `{"command":"printf '12345'; sleep 0.1; printf '67890' >&2; sleep 0.1; printf 'abcde'","inheritEnv":true,"spill":{"afterBytes":8,"afterLines":0}}`, "spill-id", nil)
	if errText != "" {
		t.Fatal(errText)
	}
	spill, ok := v.(map[string]any)["spillPath"].(string)
	if !ok || spill == "" {
		t.Fatalf("spill result = %#v", v)
	}
	contents, err := os.ReadFile(spill)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "1234567890abcde" {
		t.Fatalf("spill file %q", contents)
	}
}

func TestLineThresholdSpillsAnUnterminatedLongLineCompletely(t *testing.T) {
	state := t.TempDir()
	e := New(t.TempDir(), state)
	defer e.Close()
	long := strings.Repeat("a", 8000)
	script := "printf '" + long + "'; printf '\\nsecond'"
	payload, _ := json.Marshal(map[string]any{"command": script, "inheritEnv": true, "spill": map[string]int{"afterLines": 1}})
	value, errText := run(t, e, "exec", string(payload), "line-spill", nil)
	if errText != "" {
		t.Fatal(errText)
	}
	spill := value.(map[string]any)["spillPath"].(string)
	contents, err := os.ReadFile(spill)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != long+"\nsecond" {
		t.Fatalf("line spill size/content mismatch: %d bytes", len(contents))
	}
}

func TestOpenReaderRejectsFinalSymlinkWhenRequested(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	e := New(dir, dir)
	defer e.Close()
	_, errText := run(t, e, "openBinaryReader", `{"path":"`+link+`","noFollow":true}`, "nofollow", nil)
	if errText == "" {
		t.Fatal("followed symlink despite noFollow")
	}
}

func TestOutputSnapshotsBoundTailAndAccountForSkippedUTF8Bytes(t *testing.T) {
	e := New(t.TempDir(), t.TempDir())
	defer e.Close()
	params := map[string]any{
		"command":    "printf 'x%.0s' {1..100}",
		"inheritEnv": true,
		"window":     map[string]any{"maxBytes": 8, "maxLines": 2, "minIntervalMs": 20, "bytesPerSecond": 1000000},
	}
	payload, _ := json.Marshal(params)
	var snapshots []protocol.Output
	_, resultErr := e.Execute(context.Background(), "exec", payload, "bounded-output", func(o protocol.Output) error {
		snapshots = append(snapshots, o)
		return nil
	})
	if resultErr != nil {
		t.Fatal(resultErr)
	}
	if len(snapshots) == 0 {
		t.Fatal("no output snapshot emitted")
	}
	cursor := int64(0)
	reconstructed := ""
	for _, snapshot := range snapshots {
		if !snapshot.Snapshot {
			t.Fatalf("output is not a snapshot: %#v", snapshot)
		}
		if len(snapshot.Text) > 12 {
			t.Fatalf("retained %d bytes, cap is maxBytes+maxUTF8=12", len(snapshot.Text))
		}
		start := cursor - snapshot.Before.Bytes
		if start < 0 {
			start = 0
		}
		if start < int64(len(snapshot.Text)) {
			reconstructed += snapshot.Text[start:]
		}
		cursor = snapshot.Before.Bytes + int64(len(snapshot.Text))
	}
	last := snapshots[len(snapshots)-1]
	if last.Before.Bytes+int64(len(last.Text)) != 100 || last.Before.Bytes != 88 || reconstructed != strings.Repeat("x", 12) {
		t.Fatalf("snapshot accounting lost bytes: before=%#v retained=%d reconstructed=%q", last.Before, len(last.Text), reconstructed)
	}
}

func TestOutputSnapshotTimerFlushesBufferedTextDuringQuietPeriod(t *testing.T) {
	e := New(t.TempDir(), t.TempDir())
	defer e.Close()
	payload := json.RawMessage(`{"command":"printf a; sleep 0.02; printf b; sleep 0.3","inheritEnv":true,"window":{"maxBytes":8,"maxLines":2,"minIntervalMs":30,"bytesPerSecond":1000000}}`)
	var times []time.Time
	_, er := e.Execute(context.Background(), "exec", payload, "quiet-flush", func(protocol.Output) error { times = append(times, time.Now()); return nil })
	if er != nil {
		t.Fatal(er)
	}
	if len(times) < 2 || times[1].Sub(times[0]) > 200*time.Millisecond {
		t.Fatalf("buffered output waited for command exit: %v", times)
	}
}
