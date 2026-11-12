package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/shan-mx/amita/apps/companion/internal/client"
	"github.com/shan-mx/amita/apps/companion/internal/config"
)

const (
	startupTimeout = 15 * time.Second
	stopTimeout    = 15 * time.Second
	pollInterval   = 50 * time.Millisecond
	controlTimeout = time.Second
	alreadyRunning = "Companion is already running. Use 'restart' to restart it."
)

type Status struct {
	Running   bool `json:"running"`
	Connected bool `json:"connected"`
	PID       int  `json:"pid,omitempty"`
	Managed   bool `json:"managed"`
}

func socketPath(state string) string {
	// A short per-user path also fits Darwin's small Unix socket path limit.
	if canonical, err := filepath.EvalSymlinks(state); err == nil {
		state = canonical
	}
	hash := sha256.Sum256([]byte(filepath.Clean(state)))
	return filepath.Join("/tmp", "amita-companion-"+strconv.Itoa(os.Getuid()), hex.EncodeToString(hash[:12])+".sock")
}

func controlClient(state string) *http.Client {
	return &http.Client{Timeout: controlTimeout, Transport: &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath(state))
	}}}
}

func Query(state string) (Status, error) {
	var status Status
	response, err := controlClient(state).Get("http://companion/status")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || connectionRefused(err) {
			return status, nil
		}
		return status, fmt.Errorf("query Companion: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return status, fmt.Errorf("query Companion: HTTP %d", response.StatusCode)
	}
	err = json.NewDecoder(response.Body).Decode(&status)
	return status, err
}

// Run keeps the control channel alive until Runner has cancelled and joined its tasks.
func Run(parent context.Context, state string, c config.Config, managed bool) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	writer, err := openLog(state)
	if err != nil {
		return err
	}
	defer writer.Close()
	logger := log.New(writer, "", log.LstdFlags|log.LUTC)
	var connected atomic.Bool
	var server *http.Server
	var listener net.Listener

	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	runner := &client.Runner{StateDir: state, Config: c, Home: home}
	runner.OnClose = func() {
		if server != nil {
			_ = server.Close()
		}
		if listener != nil {
			_ = listener.Close()
		}
	}
	runner.OnConnection = func(value bool) { connected.Store(value); logger.Printf("connected=%t", value) }
	runner.OnReady = func() error {
		path := socketPath(state)
		if err := config.EnsureDir(filepath.Dir(path)); err != nil {
			return err
		}
		// Runner already owns the state lock, so any previous socket is stale.
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		var err error
		listener, err = net.Listen("unix", path)
		if err != nil {
			return err
		}
		if err = os.Chmod(path, 0600); err != nil {
			_ = listener.Close()
			return err
		}
		mux := http.NewServeMux()
		mux.HandleFunc("GET /status", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(Status{Running: true, Connected: connected.Load(), PID: os.Getpid(), Managed: managed})
		})
		mux.HandleFunc("POST /stop", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusAccepted)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			cancel()
		})
		server = &http.Server{Handler: mux, ReadHeaderTimeout: controlTimeout}
		go func() {
			if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				logger.Printf("control server: %v", err)
				cancel()
			}
		}()
		logger.Print("Companion started")
		return nil
	}
	err = runner.Run(ctx)
	logger.Print("Companion stopped")
	return err
}

func Start(state, binary string) error {
	if status, err := Query(state); err != nil {
		return err
	} else if status.Running {
		return errors.New(alreadyRunning)
	}
	if err := config.EnsureDir(state); err != nil {
		return err
	}
	crashPath := filepath.Join(state, "companion.stderr.log")
	if stat, err := os.Stat(crashPath); err == nil && stat.Size() > logMaxBytes {
		if err = os.Truncate(crashPath, 0); err != nil {
			return err
		}
	}
	crash, err := os.OpenFile(crashPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer crash.Close()
	cmd := exec.Command(binary, "start", "--foreground", "--state-dir", state)
	if err = detach(cmd); err != nil {
		return err
	}
	cmd.Stdout = crash
	cmd.Stderr = crash
	if err = cmd.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	timeout := time.NewTimer(startupTimeout)
	defer timeout.Stop()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case err := <-exited:
			return fmt.Errorf("Companion exited before startup: %v; see %s", err, crashPath)
		case <-timeout.C:
			_ = cmd.Process.Kill()
			<-exited
			return fmt.Errorf("Companion startup timed out; see %s", crashPath)
		case <-ticker.C:
			status, err := Query(state)
			if err == nil && status.Running {
				if status.PID != cmd.Process.Pid {
					_ = cmd.Process.Kill()
					<-exited
					return errors.New(alreadyRunning)
				}
				return nil
			}
		}
	}
}

func Stop(state string) error {
	status, err := Query(state)
	if err != nil || !status.Running {
		return err
	}
	response, err := controlClient(state).Post("http://companion/stop", "application/json", nil)
	if err != nil {
		return err
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		return fmt.Errorf("stop Companion: HTTP %d", response.StatusCode)
	}
	deadline := time.NewTimer(stopTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-deadline.C:
			return errors.New("timed out waiting for Companion to stop")
		case <-ticker.C:
			current, err := Query(state)
			if err != nil {
				return err
			}
			if !current.Running {
				return nil
			}
			if current.PID != status.PID {
				return errors.New(alreadyRunning)
			}
		}
	}
}
