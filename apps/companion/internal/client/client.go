package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/shan-mx/amita/apps/companion/internal/config"
	"github.com/shan-mx/amita/apps/companion/internal/executor"
	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

type Runner struct {
	StateDir     string
	Config       config.Config
	Home         string
	OnReady      func() error
	OnClose      func()
	OnConnection func(bool)
}
type operation struct {
	cancel context.CancelFunc
	shell  *shellOutput
}

type shellOutput struct {
	mu       sync.Mutex
	write    func(any) error
	latest   protocol.Output
	finished bool
}

type operations struct {
	mu     sync.Mutex
	active map[string]*operation
	group  sync.WaitGroup
}

func (o *operations) get(id string) *operation {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.active[id]
}

func (o *operations) cancelAll() {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, op := range o.active {
		op.cancel()
	}
}

func (r *Runner) Run(ctx context.Context) error {
	if err := config.Validate(r.Config); err != nil {
		return err
	}
	if err := config.EnsureDir(r.StateDir); err != nil {
		return err
	}
	lock, err := acquireStateLock(r.StateDir)
	if err != nil {
		return err
	}
	defer lock.Close()
	if r.OnClose != nil {
		defer r.OnClose()
	}
	ex := executor.New(r.Home, r.StateDir)
	defer ex.Close()
	if r.OnReady != nil {
		if err := r.OnReady(); err != nil {
			return err
		}
	}
	if r.OnConnection != nil {
		defer r.OnConnection(false)
	}
	running := &operations{active: make(map[string]*operation)}
	defer func() { running.cancelAll(); running.group.Wait() }()
	backoff := time.Second
	for ctx.Err() == nil {
		conn, ready, terminal, err := r.connect(ctx)
		if err != nil {
			if terminal {
				return nil
			}
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(backoff):
			}
			backoff = min(backoff+time.Second, 5*time.Second)
			continue
		}
		if !ready {
			_ = conn.Close(websocket.StatusInternalError, "server did not become ready")
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(backoff):
			}
			backoff = min(backoff+time.Second, 5*time.Second)
			continue
		}
		if r.OnConnection != nil {
			r.OnConnection(true)
		}
		connectedAt := time.Now()
		readCtx, stop := context.WithCancel(ctx)
		writeMu := &sync.Mutex{}
		writeText := func(s string) error {
			writeMu.Lock()
			defer writeMu.Unlock()
			return conn.Write(readCtx, websocket.MessageText, []byte(s))
		}
		write := func(v any) error {
			b, e := json.Marshal(v)
			if e != nil {
				return e
			}
			return writeText(string(b))
		}
		done := make(chan error, 1)
		go func() {
			done <- readLoop(ctx, readCtx, conn, ex, running, writeText, write)
		}()
		ping := time.NewTicker(10 * time.Second)
		loop := true
		readDone := false
		revoked := false
		for loop {
			select {
			case <-ctx.Done():
				loop = false
			case <-ping.C:
				if err := writeText("ping"); err != nil {
					loop = false
				}
			case err := <-done:
				readDone = true
				revoked = isTerminal(err)
				loop = false
			}
		}
		if r.OnConnection != nil {
			r.OnConnection(false)
		}
		ping.Stop()
		stop()
		_ = conn.CloseNow()
		if !readDone {
			revoked = isTerminal(<-done)
		}
		ex.Close()
		if revoked {
			return nil
		}
		if time.Since(connectedAt) > 30*time.Second {
			backoff = time.Second
		} else {
			backoff = min(backoff+time.Second, 5*time.Second)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
	}
	return nil
}

func (r *Runner) connect(ctx context.Context) (*websocket.Conn, bool, bool, error) {
	u, err := url.Parse(r.Config.Server)
	if err != nil {
		return nil, false, false, err
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/companion/connect"
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	hdr := http.Header{"Authorization": []string{"Bearer " + r.Config.Credential}}
	client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 0 && !sameOrigin(via[0].URL, req.URL) {
			req.Header.Del("Authorization")
		}
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return nil
	}}
	conn, response, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPClient: client, HTTPHeader: hdr})
	if err != nil {
		if response != nil && (response.StatusCode == 401 || response.StatusCode == 403) {
			return nil, false, true, err
		}
		return nil, false, false, err
	}
	conn.SetReadLimit(protocol.MaxFrameBytes)
	hello := protocol.Frame{Type: "hello", Protocol: protocol.Version, Name: r.Config.Name, CWD: r.Config.CWD, Home: r.Home, OS: runtime.GOOS}
	b, _ := json.Marshal(hello)
	if err = conn.Write(ctx, websocket.MessageText, b); err != nil {
		_ = conn.Close(websocket.StatusInternalError, "hello failed")
		return nil, false, false, err
	}
	_, b, err = conn.Read(ctx)
	if err != nil {
		return nil, false, false, err
	}
	if string(b) == "ping" {
		_ = conn.Write(ctx, websocket.MessageText, []byte("pong"))
		_, b, err = conn.Read(ctx)
		if err != nil {
			return nil, false, false, err
		}
	}
	var f protocol.Frame
	if err = json.Unmarshal(b, &f); err != nil || f.Type != "ready" {
		return nil, false, false, fmt.Errorf("server did not send ready")
	}
	return conn, true, false, nil
}
func sameOrigin(a, b *url.URL) bool {
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Host, b.Host)
}
func isTerminal(err error) bool {
	var ce websocket.CloseError
	return errors.As(err, &ce) && ce.Code == 4003
}

func readLoop(ctx, readCtx context.Context, conn *websocket.Conn, ex *executor.Executor, running *operations, writeText func(string) error, write func(any) error) error {
	transfers := &fileTransfers{active: make(map[string]*incomingFile)}
	defer transfers.close()

	for {
		typ, b, err := conn.Read(readCtx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			continue
		}
		if string(b) == "ping" {
			if err = writeText("pong"); err != nil {
				return err
			}
			continue
		}
		if string(b) == "pong" {
			continue
		}
		var f protocol.Frame
		if err = json.Unmarshal(b, &f); err != nil {
			continue
		}
		switch f.Type {
		case "file_request":
			transfers.start(readCtx, f, ex, write)
		case "file_chunk", "file_end", "file_cancel":
			transfers.feed(f)
		case "execute":
			parent := readCtx
			if f.Method == "exec" {
				parent = ctx
			}
			running.start(parent, f, ex, write)
		case "resume":
			if err := running.resume(f, write); err != nil {
				return err
			}
		case "cancel":
			if op := running.get(f.ID); op != nil {
				op.cancel()
			}
		}
	}
}

func (o *operations) start(parent context.Context, f protocol.Frame, ex *executor.Executor, write func(any) error) {
	if f.ID == "" {
		return
	}
	deadline := time.UnixMilli(f.Deadline)
	if f.Deadline != 0 && !time.Now().Before(deadline) {
		_ = write(failedResult(f.ID, 1, protocol.ExpiredBeforeStart, "operation deadline expired before execution"))
		return
	}
	var ctx context.Context
	var cancel context.CancelFunc
	if f.Deadline == 0 {
		ctx, cancel = context.WithCancel(parent)
	} else {
		ctx, cancel = context.WithDeadline(parent, deadline)
	}
	op := &operation{cancel: cancel}
	var emit executor.Emit
	if f.Method == "exec" {
		op.shell = &shellOutput{write: write}
		emit = op.shell.publish
	}

	o.mu.Lock()
	if o.active[f.ID] != nil {
		o.mu.Unlock()
		cancel()
		return
	}
	o.active[f.ID] = op
	o.mu.Unlock()
	o.group.Add(1)
	go func() {
		defer o.group.Done()
		defer cancel()
		defer func() {
			o.mu.Lock()
			delete(o.active, f.ID)
			o.mu.Unlock()
		}()
		var value any
		var err *protocol.ResultError
		if f.Workspace != "" {
			err = ex.EnsureWorkspace(ctx, f.Workspace)
		}
		if err == nil {
			value, err = ex.Execute(ctx, f.Method, f.Params, f.ID, emit)
		}
		result := protocol.ResultFrame{
			Type: "result", ID: f.ID, Seq: 1,
			Result: protocol.Result{OK: err == nil, Value: value, Error: err},
		}
		if op.shell != nil {
			op.shell.finish(result)
		} else {
			_ = write(result)
		}
	}()
}

func (s *shellOutput) publish(output protocol.Output) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	output.Type = protocol.OutputType
	output.Seq = s.latest.Seq + 1
	s.latest = output
	_ = s.write(output)
	return nil
}

func (s *shellOutput) finish(result protocol.ResultFrame) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.finished = true
	result.Seq = s.latest.Seq + 1
	_ = s.write(result)
}

func (o *operations) resume(f protocol.Frame, write func(any) error) error {
	if op := o.get(f.ID); op != nil && op.shell != nil {
		shell := op.shell
		shell.mu.Lock()
		defer shell.mu.Unlock()
		if !shell.finished {
			shell.write = write
			if shell.latest.Seq > f.After {
				return write(shell.latest)
			}
			return nil
		}
	}
	return write(failedResult(f.ID, f.After+1, "unknown", "the original command is no longer attached to this Companion"))
}

func failedResult(id string, seq int64, code, message string) protocol.ResultFrame {
	return protocol.ResultFrame{
		Type: "result", ID: id, Seq: seq,
		Result: protocol.Result{OK: false, Error: &protocol.ResultError{Code: code, Message: message}},
	}
}
