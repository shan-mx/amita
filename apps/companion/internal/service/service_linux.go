//go:build linux

package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/shan-mx/amita/apps/companion/internal/config"
)

const noAutostart = "Login autostart requires a systemd user manager or a desktop login session."
const wslAutostart = "Login autostart requires an available systemd user manager in WSL. Enable systemd, restart the distribution, and try again."

func configPath(parts ...string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	base := config.XDGDir("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	return filepath.Join(append([]string{base}, parts...)...), nil
}
func unitName(state string) string          { return Label(state) + ".service" }
func unitPath(state string) (string, error) { return configPath("systemd", "user", unitName(state)) }
func desktopPath(state string) (string, error) {
	return configPath("autostart", Label(state)+".desktop")
}
func userManagerAvailable() bool {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	// Run discards the environment output; only the user manager's availability matters.
	return exec.CommandContext(ctx, "systemctl", "--user", "show-environment").Run() == nil
}
func isWSL() bool {
	if os.Getenv("WSL_DISTRO_NAME") != "" {
		return true
	}
	b, _ := os.ReadFile("/proc/sys/kernel/osrelease")
	return strings.Contains(strings.ToLower(string(b)), "microsoft")
}
func desktopAvailable() bool { return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" }
func systemdArg(value string) string {
	value = strings.ReplaceAll(value, "%", "%%")
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, "\"", "\\\"")
	value = strings.ReplaceAll(value, "\n", "\\n")
	value = strings.ReplaceAll(value, "\r", "\\r")
	value = strings.ReplaceAll(value, "\t", "\\t")
	return "\"" + value + "\""
}
func unitContent(state, pathEnv string) string {
	args := []string{BinaryPath(state), "start", "--foreground", "--state-dir", state}
	for i := range args {
		// systemd expands environment variables in arguments, but not in the executable.
		if i > 0 {
			args[i] = strings.ReplaceAll(args[i], "$", "$$")
		}
		args[i] = systemdArg(args[i])
	}
	return fmt.Sprintf("# %s\n[Unit]\nDescription=Amita Companion\nStartLimitIntervalSec=120\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart=%s\nEnvironment=%s\nEnvironment=%s=1\nRestart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n", managedMarker, strings.Join(args, " "), systemdArg("PATH="+pathEnv), ManagedEnv)
}
func desktopArg(value string) string {
	value = strings.ReplaceAll(value, "%", "%%")
	replacer := strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "`", "\\`", "$", "\\$")
	// The desktop entry parser processes backslashes before the Exec parser.
	return "\"" + strings.ReplaceAll(replacer.Replace(value), "\\", "\\\\") + "\""
}
func desktopContent(state, pathEnv string) string {
	args := []string{"/usr/bin/env", "PATH=" + pathEnv, ManagedEnv + "=1", BinaryPath(state), "start", "--foreground", "--state-dir", state}
	for i := range args {
		args[i] = desktopArg(args[i])
	}
	return fmt.Sprintf("# %s\n[Desktop Entry]\nType=Application\nName=Amita Companion\nExec=%s\nTerminal=false\n", managedMarker, strings.Join(args, " "))
}
func enable(state, pathEnv string) error {
	if userManagerAvailable() {
		path, err := unitPath(state)
		if err != nil {
			return err
		}
		if err = writeManaged(path, unitContent(state, pathEnv)); err != nil {
			return err
		}
		if _, err = command("systemctl", "--user", "daemon-reload"); err != nil {
			return err
		}
		if _, err = command("systemctl", "--user", "enable", unitName(state)); err != nil {
			return err
		}
		old, err := desktopPath(state)
		if err != nil {
			return err
		}
		// Only remove our own desktop entry during a mechanism transition.
		registration, err := readRegistration(old, "xdg")
		if err != nil {
			return err
		}
		if registration.Managed {
			return removeManaged(old)
		}
		return nil
	}
	if isWSL() {
		return errors.New(wslAutostart)
	}
	if !desktopAvailable() {
		return errors.New(noAutostart)
	}
	path, err := desktopPath(state)
	if err != nil {
		return err
	}
	return writeManaged(path, desktopContent(state, pathEnv))
}
func refresh(state, pathEnv string) error {
	registration, err := Inspect(state)
	if err != nil {
		return err
	}
	content := desktopContent(state, pathEnv)
	if registration.Mechanism == "systemd" {
		content = unitContent(state, pathEnv)
	}
	if err = writeManaged(registration.Location, content); err != nil {
		return err
	}
	if registration.Mechanism == "systemd" && userManagerAvailable() {
		_, err = command("systemctl", "--user", "daemon-reload")
	}
	return err
}
func Inspect(state string) (Registration, error) {
	path, err := unitPath(state)
	if err != nil {
		return Registration{}, err
	}
	registration, err := readRegistration(path, "systemd")
	if err != nil {
		return registration, err
	}
	if registration.Present {
		link := filepath.Join(filepath.Dir(path), "default.target.wants", unitName(state))
		stat, e := os.Lstat(link)
		registration.Enabled = e == nil && stat.Mode()&os.ModeSymlink != 0
		return registration, nil
	}
	path, err = desktopPath(state)
	if err != nil {
		return Registration{}, err
	}
	return readRegistration(path, "xdg")
}
func Disable(state string) error {
	path, err := unitPath(state)
	if err != nil {
		return err
	}
	unit, err := readRegistration(path, "systemd")
	if err != nil {
		return err
	}
	desktop, err := desktopPath(state)
	if err != nil {
		return err
	}
	entry, err := readRegistration(desktop, "xdg")
	if err != nil {
		return err
	}
	for _, r := range []Registration{unit, entry} {
		if r.Present && !r.Managed {
			return fmt.Errorf("autostart entry is not managed by Amita: %s", r.Location)
		}
	}
	if unit.Present {
		if userManagerAvailable() {
			if _, err = command("systemctl", "--user", "disable", unitName(state)); err != nil {
				return err
			}
		} else {
			link := filepath.Join(filepath.Dir(path), "default.target.wants", unitName(state))
			if err = os.Remove(link); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		if err = removeManaged(path); err != nil {
			return err
		}
		if userManagerAvailable() {
			if _, err = command("systemctl", "--user", "daemon-reload"); err != nil {
				return err
			}
		}
	}
	return removeManaged(desktop)
}
func Status(state string) (bool, error) {
	if !userManagerAvailable() {
		return false, nil
	}
	output, err := command("systemctl", "--user", "is-active", unitName(state))
	if err != nil {
		value := strings.TrimSpace(string(output))
		if value == "inactive" || value == "failed" || value == "unknown" {
			return false, nil
		}
		return false, err
	}
	return strings.TrimSpace(string(output)) == "active", nil
}
