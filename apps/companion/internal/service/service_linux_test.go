//go:build linux

package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func serviceEnvironment(t *testing.T, systemd bool) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("DISPLAY", "")
	t.Setenv("WAYLAND_DISPLAY", "")
	t.Setenv("WSL_DISTRO_NAME", "")
	bin := filepath.Join(home, "tools")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nexit 1\n"
	if systemd {
		script = `#!/bin/sh
case "$2" in
 show-environment|daemon-reload) exit 0;;
 enable) /bin/mkdir -p "$XDG_CONFIG_HOME/systemd/user/default.target.wants"; /bin/ln -sf "../$3" "$XDG_CONFIG_HOME/systemd/user/default.target.wants/$3";;
 disable) /bin/rm -f "$XDG_CONFIG_HOME/systemd/user/default.target.wants/$3";;
 is-active) echo inactive; exit 3;;
 *) echo unexpected operation >&2; exit 99;;
esac
`
	}
	if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	return filepath.Join(home, "state with spaces % value")
}

func TestSystemdRegistrationDoesNotStartOrStopProcess(t *testing.T) {
	state := serviceEnvironment(t, true)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err = Enable(state, executable); err != nil {
		t.Fatal(err)
	}
	registration, err := Inspect(state)
	if err != nil || !registration.Enabled || !registration.Managed || registration.Mechanism != "systemd" {
		t.Fatalf("registration = %#v, %v", registration, err)
	}
	running, err := Status(state)
	if err != nil || running {
		t.Fatalf("enable started runtime: %v, %v", running, err)
	}
	unit, err := os.ReadFile(registration.Location)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(unit), "state with spaces %% value") || !strings.Contains(string(unit), "--foreground") {
		t.Fatalf("incorrect service command: %s", unit)
	}
	if err = Disable(state); err != nil {
		t.Fatal(err)
	}
	registration, err = Inspect(state)
	if err != nil || registration.Present {
		t.Fatalf("disabled registration = %#v, %v", registration, err)
	}
	if _, err = os.Stat(BinaryPath(state)); err != nil {
		t.Fatalf("disable removed binary: %v", err)
	}
}

func TestWSLWithoutUserManagerExplainsRequirement(t *testing.T) {
	state := serviceEnvironment(t, false)
	t.Setenv("WSL_DISTRO_NAME", "Fixture")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err = Enable(state, binary); err == nil || err.Error() != wslAutostart {
		t.Fatalf("WSL unavailable manager = %v", err)
	}
	registration, err := Inspect(state)
	if err != nil || registration.Present {
		t.Fatalf("failed enable registered autostart: %#v %v", registration, err)
	}
}

func TestDesktopFallbackAndUnmanagedEntries(t *testing.T) {
	state := serviceEnvironment(t, false)
	// Do not depend on the test host's kernel when checking the desktop mechanism.
	if isWSL() {
		t.Skip("desktop fallback is only selected outside WSL")
	}
	t.Setenv("DISPLAY", ":1")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err = Enable(state, binary); err != nil {
		t.Fatal(err)
	}
	registration, err := Inspect(state)
	if err != nil || registration.Mechanism != "xdg" || !registration.Enabled {
		t.Fatalf("desktop registration = %#v %v", registration, err)
	}
	if err = os.WriteFile(registration.Location, []byte("[Desktop Entry]\nName=User entry\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = Enable(state, binary); err == nil {
		t.Fatal("overwrote a user-owned entry")
	}
	if err = Disable(state); err == nil {
		t.Fatal("removed a user-owned entry")
	}
}

func TestDesktopEntryLaunchesLiteralArgumentsThroughGIO(t *testing.T) {
	gio, err := exec.LookPath("gio")
	if err != nil {
		t.Skip("GIO desktop launcher is not installed")
	}
	root := t.TempDir()
	state := filepath.Join(root, "state with % and $ and ` and \" characters")
	if err = os.MkdirAll(filepath.Dir(BinaryPath(state)), 0700); err != nil {
		t.Fatal(err)
	}
	capture := filepath.Join(root, "arguments")
	t.Setenv("AMITA_TEST_ARGUMENTS", capture)
	script := []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$AMITA_TEST_ARGUMENTS\"\n")
	if err = os.WriteFile(BinaryPath(state), script, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "amita.desktop")
	if err = os.WriteFile(path, []byte(desktopContent(state, os.Getenv("PATH"))), 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(gio, "launch", path).CombinedOutput(); err != nil {
		t.Fatalf("desktop launch: %v: %s", err, output)
	}
	deadline := time.Now().Add(3 * time.Second)
	var captured []byte
	for time.Now().Before(deadline) {
		captured, _ = os.ReadFile(capture)
		if string(captured) == "start\n--foreground\n--state-dir\n"+state+"\n" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("desktop entry did not preserve its foreground arguments: %q", captured)
}
