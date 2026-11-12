//go:build darwin || linux

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shan-mx/amita/apps/companion/internal/config"
)

func TestCLIBackgroundLifecycleWithoutServiceInstallation(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "amita-companion")
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v: %s", err, output)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "offline fixture", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	first := filepath.Join(t.TempDir(), "first state with spaces")
	second := filepath.Join(t.TempDir(), "second state")
	invoke := func(state string, args ...string) (string, error) {
		args = append(args, "--state-dir", state)
		output, err := exec.Command(binary, args...).CombinedOutput()
		return string(output), err
	}
	for _, state := range []string{first, second} {
		if err := config.Save(state, config.Config{Server: server.URL, DeviceID: "fixture", Credential: "fixture", Name: "fixture", Slug: "fixture", CWD: state}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = invoke(state, "stop") })
		if output, err := invoke(state, "start"); err != nil {
			t.Fatalf("start without installation: %v: %s", err, output)
		}
	}
	readStatus := func(state string) map[string]any {
		t.Helper()
		output, err := invoke(state, "status")
		if err != nil {
			t.Fatalf("status: %v: %s", err, output)
		}
		var status map[string]any
		if err = json.Unmarshal([]byte(output), &status); err != nil {
			t.Fatalf("decode status: %v: %s", err, output)
		}
		return status
	}
	if status := readStatus(first); status["running"] != true || status["connected"] != false || status["paired"] != true {
		t.Fatalf("offline running status = %#v", status)
	}
	if output, err := invoke(first, "start"); err == nil || !strings.Contains(output, "already running") {
		t.Fatalf("duplicate start = %v: %s", err, output)
	}
	if output, err := invoke(first, "restart"); err != nil {
		t.Fatalf("restart: %v: %s", err, output)
	}
	if output, err := invoke(first, "logs", "-n", "10"); err != nil || !strings.Contains(output, "Log file:") {
		t.Fatalf("logs: %v: %s", err, output)
	}
	if output, err := invoke(first, "stop"); err != nil {
		t.Fatalf("stop: %v: %s", err, output)
	}
	if status := readStatus(first); status["running"] != false || status["paired"] != true {
		t.Fatalf("stopped status = %#v", status)
	}
	if status := readStatus(second); status["running"] != true {
		t.Fatalf("sibling stopped: %#v", status)
	}
	// Stop is idempotent, including after a completed shutdown.
	if output, err := invoke(first, "stop"); err != nil {
		t.Fatalf("second stop: %v: %s", err, output)
	}
}
