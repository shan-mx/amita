package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/shan-mx/amita/apps/companion/internal/config"
	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

func TestLiveOutputFramesStayValidOnOneConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	observed := make(chan error, 1)
	var connections atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		connections.Add(1)
		conn, err := websocket.Accept(w, req, nil)
		if err != nil {
			observed <- err
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		_, helloBytes, err := conn.Read(ctx)
		if err != nil {
			observed <- err
			return
		}
		var hello protocol.Frame
		if err = json.Unmarshal(helloBytes, &hello); err != nil || hello.OS != runtime.GOOS || hello.Protocol != protocol.Version || hello.CWD != "/fixture" {
			observed <- fmt.Errorf("Companion sent an unexpected hello: %s", helloBytes)
			return
		}
		if err = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"ready"}`)); err != nil {
			observed <- err
			return
		}
		params, _ := json.Marshal(map[string]any{"command": "printf 'wire-out\\n'; sleep 1; printf 'wire-err\\n' >&2", "inheritEnv": true})
		request, _ := json.Marshal(protocol.Frame{Type: "execute", ID: "live-wire", Method: "exec", Params: params})
		if err = conn.Write(ctx, websocket.MessageText, request); err != nil {
			observed <- err
			return
		}
		var latest string
		var first time.Time
		var sequence int64
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				observed <- err
				return
			}
			var frame protocol.Frame
			if err = json.Unmarshal(raw, &frame); err != nil {
				observed <- err
				return
			}
			if frame.ID != "live-wire" || frame.Seq <= sequence {
				observed <- fmt.Errorf("invalid frame identity/sequence: %s", raw)
				return
			}
			sequence = frame.Seq
			switch frame.Type {
			case "output":
				if first.IsZero() {
					first = time.Now()
				}
				if !frame.Snapshot || (frame.Stream != "stdout" && frame.Stream != "stderr") {
					observed <- fmt.Errorf("invalid cumulative output: %s", raw)
					return
				}
				latest = frame.Text
			case "result":
				if first.IsZero() || time.Since(first) < 500*time.Millisecond || latest != "wire-out\nwire-err\n" || frame.Result == nil || !frame.Result.OK {
					observed <- fmt.Errorf("live output/result mismatch: output=%q result=%s", latest, raw)
					return
				}
				observed <- nil
				<-ctx.Done()
				return
			default:
				_ = conn.Close(websocket.StatusUnsupportedData, "Invalid Companion protocol")
				observed <- fmt.Errorf("invalid live frame discriminator: %s", raw)
				return
			}
		}
	}))
	defer func() { cancel(); server.Close() }()
	runner := &Runner{StateDir: t.TempDir(), Config: config.Config{Server: server.URL, DeviceID: "device", Credential: "fixture", Name: "fixture", Slug: "fixture", CWD: "/fixture"}, Home: t.TempDir()}
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	err := <-observed
	cancel()
	if runErr := <-done; runErr != nil {
		t.Fatal(runErr)
	}
	if err != nil {
		t.Fatal(err)
	}
	if connections.Load() != 1 {
		t.Fatalf("expected one connection, got %d", connections.Load())
	}
}

func TestRunUnknownResumeAndExpiredExecuteDoNotStart(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state")
	fixture := filepath.Join(t.TempDir(), "must-not-exist")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		_, _, err = conn.Read(r.Context())
		if err != nil {
			return
		}
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"ready"}`))
		write := func(v any) { b, _ := json.Marshal(v); _ = conn.Write(r.Context(), websocket.MessageText, b) }
		write(protocol.Frame{Type: "resume", ID: "never-seen", After: 7})
		expired := time.Now().Add(-time.Minute).UnixMilli()
		params, _ := json.Marshal(map[string]any{"command": []string{"/bin/bash", "-c", "touch '" + fixture + "'"}, "inheritEnv": true})
		write(protocol.Frame{Type: "execute", ID: "expired", Method: "exec", Params: params, Deadline: expired})
		seen := 0
		for seen < 2 {
			readCtx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			_, b, e := conn.Read(readCtx)
			cancel()
			if e != nil {
				got <- e
				return
			}
			var f protocol.Frame
			if json.Unmarshal(b, &f) == nil && f.Type == "result" {
				if f.ID == "never-seen" && (f.Seq != 8 || f.Result == nil || f.Result.Error == nil || f.Result.Error.Code != "unknown") {
					t.Errorf("unknown resume result = %s", b)
				}
				if f.ID == "expired" && (f.Result == nil || f.Result.Error == nil || f.Result.Error.Code != "expired_before_start") {
					t.Errorf("expired execution result = %#v, want expired_before_start", f.Result)
				}
				seen++
			}
		}
		got <- nil
		<-r.Context().Done()
	}))
	defer server.Close()
	r := &Runner{StateDir: state, Config: config.Config{Server: server.URL, DeviceID: "device", Credential: "x", Name: "test"}, Home: t.TempDir()}
	go func() { got <- r.Run(ctx) }()
	select {
	case err := <-got:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("errors were not returned")
	}
	cancel()
	if _, err := os.Stat(fixture); !os.IsNotExist(err) {
		t.Fatalf("expired effect exists; stat error %v", err)
	}
}

func TestRunAcceptsExecutionFrameAboveDefaultWebSocketLimit(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		_, _, err = conn.Read(r.Context())
		if err != nil {
			return
		}
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"ready"}`))
		future := time.Now().Add(time.Minute).UnixMilli()
		params, _ := json.Marshal(map[string]any{"command": "true", "env": map[string]string{"AMITA_LARGE_TEST": strings.Repeat("v", 40*1024)}, "inheritEnv": true})
		frame, _ := json.Marshal(protocol.Frame{Type: "execute", ID: "large-frame", Method: "exec", Params: params, Deadline: future})
		if len(frame) <= 32*1024 {
			result <- context.Canceled
			return
		}
		if err = conn.Write(r.Context(), websocket.MessageText, frame); err != nil {
			result <- err
			return
		}
		readCtx, stop := context.WithTimeout(r.Context(), 5*time.Second)
		defer stop()
		for {
			_, b, e := conn.Read(readCtx)
			if e != nil {
				result <- e
				return
			}
			var f map[string]any
			if json.Unmarshal(b, &f) == nil && f["type"] == "result" {
				res, _ := f["result"].(map[string]any)
				if res["ok"] != true {
					result <- context.Canceled
				} else {
					result <- nil
				}
				<-r.Context().Done()
				return
			}
		}
	}))
	defer server.Close()
	runner := &Runner{StateDir: state, Config: config.Config{Server: server.URL, DeviceID: "device", Credential: "credential", Name: "test"}, Home: t.TempDir()}
	go func() { _ = runner.Run(ctx) }()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(7 * time.Second):
		t.Fatal("large execution frame was not handled")
	}
	cancel()
}

func TestActiveCommandAttachesAcrossDisconnect(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state")
	fixture := filepath.Join(t.TempDir(), "effect")
	finish := filepath.Join(t.TempDir(), "finish")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var connections atomic.Int32
	done := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := connections.Add(1)
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		_, _, err = conn.Read(r.Context())
		if err != nil {
			return
		}
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"ready"}`))
		if n == 1 {
			future := time.Now().Add(time.Minute).UnixMilli()
			params, _ := json.Marshal(map[string]any{"command": "echo ready; while [ ! -f '" + finish + "' ]; do sleep 0.05; done; printf x >> '" + fixture + "'; echo completed", "inheritEnv": true})
			b, _ := json.Marshal(protocol.Frame{Type: "execute", ID: "reconnect-op", Method: "exec", Params: params, Deadline: future})
			_ = conn.Write(r.Context(), websocket.MessageText, b)
			readCtx, stop := context.WithTimeout(r.Context(), 3*time.Second)
			_, raw, err := conn.Read(readCtx)
			stop()
			var output protocol.Frame
			if err != nil || json.Unmarshal(raw, &output) != nil || output.Type != "output" || output.Text != "ready\n" {
				done <- fmt.Errorf("command did not start before disconnect: %s (%v)", raw, err)
				return
			}
			_ = conn.Close(websocket.StatusServiceRestart, "retry")
			return
		}
		b, _ := json.Marshal(protocol.Frame{Type: "resume", ID: "reconnect-op", After: 0})
		if err = conn.Write(r.Context(), websocket.MessageText, b); err != nil {
			done <- err
			return
		}
		readCtx, stop := context.WithTimeout(r.Context(), 3*time.Second)
		_, snapshot, err := conn.Read(readCtx)
		stop()
		var output protocol.Frame
		if err != nil || json.Unmarshal(snapshot, &output) != nil || output.Type != "output" || output.Text != "ready\n" || output.Seq != 1 {
			done <- fmt.Errorf("missing output snapshot on reconnect: %s (%v)", snapshot, err)
			return
		}
		if err = os.WriteFile(finish, nil, 0600); err != nil {
			done <- err
			return
		}
		for {
			readCtx, stop := context.WithTimeout(r.Context(), 5*time.Second)
			_, b, e := conn.Read(readCtx)
			stop()
			if e != nil {
				done <- e
				return
			}
			var f map[string]any
			if json.Unmarshal(b, &f) == nil && f["type"] == "result" {
				result, _ := f["result"].(map[string]any)
				if result["ok"] != true {
					done <- context.Canceled
					return
				}
				done <- nil
				<-r.Context().Done()
				return
			}
		}
	}))
	defer server.Close()
	r := &Runner{StateDir: state, Config: config.Config{Server: server.URL, DeviceID: "device", Credential: "credential", Name: "test"}, Home: t.TempDir()}
	go func() { _ = r.Run(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("the original command did not finish after reconnect")
	}
	cancel()
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "x" {
		t.Fatalf("side effect ran %d times: %q", len(b), b)
	}
	if connections.Load() < 2 {
		t.Fatalf("connection count = %d", connections.Load())
	}
}

func TestTerminalAuthFailureCancelsWorkFromPriorConnection(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state")
	fixture := filepath.Join(t.TempDir(), "late-effect")
	started := filepath.Join(t.TempDir(), "started")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var connections atomic.Int32
	done := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if connections.Add(1) > 1 {
			http.Error(w, "revoked", http.StatusForbidden)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "drop")
		_, _, err = conn.Read(r.Context())
		if err != nil {
			return
		}
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"ready"}`))
		future := time.Now().Add(time.Minute).UnixMilli()
		params, _ := json.Marshal(map[string]any{"command": "touch '" + started + "'; sleep 5; touch '" + fixture + "'", "inheritEnv": true})
		b, _ := json.Marshal(protocol.Frame{Type: "execute", ID: "auth-loss", Method: "exec", Params: params, Deadline: future})
		_ = conn.Write(r.Context(), websocket.MessageText, b)
		limit := time.Now().Add(3 * time.Second)
		for time.Now().Before(limit) {
			if _, e := os.Stat(started); e == nil {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		_ = conn.Close(websocket.StatusServiceRestart, "retry")
	}))
	defer server.Close()
	r := &Runner{StateDir: state, Config: config.Config{Server: server.URL, DeviceID: "device", Credential: "credential", Name: "test"}, Home: t.TempDir()}
	start := time.Now()
	go func() { done <- r.Run(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("terminal authentication failure did not stop Runner")
	}
	if time.Since(start) > 4*time.Second {
		t.Fatalf("terminal cleanup took %v", time.Since(start))
	}
	if _, err := os.Stat(fixture); !os.IsNotExist(err) {
		t.Fatalf("child process survived terminal auth failure: %v", err)
	}
}
