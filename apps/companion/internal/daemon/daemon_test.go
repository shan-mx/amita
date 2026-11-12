//go:build darwin || linux

package daemon

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/shan-mx/amita/apps/companion/internal/config"
)

func TestControlTracksConnectionAndWaitsForShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var disconnect atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if disconnect.Load() {
			http.Error(w, "offline", 503)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		if _, _, err = conn.Read(ctx); err != nil {
			return
		}
		if err = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"ready"}`)); err != nil {
			return
		}
		for !disconnect.Load() && ctx.Err() == nil {
			time.Sleep(10 * time.Millisecond)
		}
	}))
	defer server.Close()
	state := t.TempDir()
	done := make(chan error, 1)
	cfg := config.Config{Server: server.URL, DeviceID: "test", Credential: "test", Name: "test", Slug: "test", CWD: state}
	go func() { done <- Run(ctx, state, cfg, false) }()
	waitStatus := func(predicate func(Status) bool) Status {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			status, err := Query(state)
			if err != nil {
				t.Fatal(err)
			}
			if predicate(status) {
				return status
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("status did not reach expected state")
		return Status{}
	}
	waitStatus(func(s Status) bool { return s.Running && s.Connected })
	if err := Run(ctx, state, cfg, false); err == nil {
		t.Fatal("second process acquired the same state")
	}
	disconnect.Store(true)
	waitStatus(func(s Status) bool { return s.Running && !s.Connected })
	if err := Stop(state); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runner remained active after stop")
	}
	if status, err := Query(state); err != nil || status.Running {
		t.Fatalf("stopped = %#v, %v", status, err)
	}
	if err := Stop(state); err != nil {
		t.Fatal(err)
	}
}

func TestLogsRotateAndTailLatestLines(t *testing.T) {
	state := t.TempDir()
	writer, err := openLog(state)
	if err != nil {
		t.Fatal(err)
	}
	writer.maxBytes = 12
	for _, line := range []string{"first line\n", "second line\n", "third line\n"} {
		if _, err = writer.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	previous, err := os.ReadFile(filepath.Join(state, "companion.log.1"))
	if err != nil || string(previous) != "second line\n" {
		t.Fatalf("backup = %q, %v", previous, err)
	}
	var output strings.Builder
	if err = Logs(context.Background(), state, 1, false, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "third line\n") || strings.Contains(output.String(), "first line\n") {
		t.Fatalf("tail = %q", output.String())
	}
}
