//go:build darwin

package service

import (
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func plistPath(state string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", Label(state)+".plist"), nil
}
func xmlEscape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
func plistContent(state, pathEnv string) string {
	var args strings.Builder
	for _, arg := range []string{BinaryPath(state), "run", "--state-dir", state} {
		fmt.Fprintf(&args, "<string>%s</string>\n", xmlEscape(arg))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!-- %s -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>%s</string>
<key>ProgramArguments</key><array>%s</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>%s</string><key>%s</key><string>1</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`, managedMarker, Label(state), args.String(), xmlEscape(pathEnv), ManagedEnv)
}
func refresh(state, pathEnv string) error {
	path, err := plistPath(state)
	if err != nil {
		return err
	}
	return writeManaged(path, plistContent(state, pathEnv))
}
func enable(state, pathEnv string) error {
	if err := refresh(state, pathEnv); err != nil {
		return err
	}
	_, err := command("launchctl", "enable", "gui/"+strconv.Itoa(os.Getuid())+"/"+Label(state))
	return err
}
func Inspect(state string) (Registration, error) {
	path, err := plistPath(state)
	if err != nil {
		return Registration{}, err
	}
	return readRegistration(path, "launchd")
}
func Disable(state string) error {
	registration, err := Inspect(state)
	if err != nil || !registration.Present {
		return err
	}
	if !registration.Managed {
		return fmt.Errorf("autostart entry is not managed by Amita: %s", registration.Location)
	}
	// Disable restarts without stopping a currently running job.
	if _, err = command("launchctl", "disable", "gui/"+strconv.Itoa(os.Getuid())+"/"+Label(state)); err != nil {
		return err
	}
	return removeManaged(registration.Location)
}
func Status(state string) (bool, error) {
	output, err := command("launchctl", "print", "gui/"+strconv.Itoa(os.Getuid())+"/"+Label(state))
	if err != nil {
		if strings.Contains(string(output), "Could not find service") {
			return false, nil
		}
		return false, err
	}
	return isRunningOutput(string(output)), nil
}
func isRunningOutput(output string) bool {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "state = running" {
			return true
		}
		if strings.HasPrefix(line, "pid = ") {
			pid, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "pid = ")))
			if err == nil && pid > 0 {
				return true
			}
		}
	}
	return false
}
