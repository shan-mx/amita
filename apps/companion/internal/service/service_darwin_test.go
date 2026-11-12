//go:build darwin

package service

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLaunchAgentKeepsIdentityAndForegroundArguments(t *testing.T) {
	state := "/Users/fixture/state with & spaces"
	content := plistContent(state, "/opt/tools:/usr/bin")
	var parsed struct {
		Dict struct {
			Keys    []string `xml:"key"`
			Strings []string `xml:"string"`
			Arrays  []struct {
				Strings []string `xml:"string"`
			} `xml:"array"`
		} `xml:"dict"`
	}
	if err := xml.Unmarshal([]byte(content), &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Dict.Arrays) != 1 {
		t.Fatalf("arguments = %#v", parsed.Dict.Arrays)
	}
	args := parsed.Dict.Arrays[0].Strings
	want := []string{BinaryPath(state), "run", "--state-dir", state}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v", args)
	}
	if !strings.Contains(content, Label(state)) || !strings.Contains(content, "/opt/tools:/usr/bin") {
		t.Fatal("lost registration identity or PATH")
	}
}

func TestRefreshLeavesUnmanagedLaunchAgentUntouched(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	state := filepath.Join(home, "companion state")
	path, err := plistPath(state)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	unmanaged := fmt.Sprintf(`<plist version="1.0"><dict><key>Label</key><string>%s</string><key>ProgramArguments</key><array><string>%s</string><string>run</string><string>--state-dir</string><string>%s</string></array></dict></plist>`, Label(state), xmlEscape(BinaryPath(state)), xmlEscape(state))
	if err = os.WriteFile(path, []byte(unmanaged), 0600); err != nil {
		t.Fatal(err)
	}
	registration, err := Inspect(state)
	if err != nil || !registration.Present || registration.Managed {
		t.Fatalf("unexpected registration: %#v, %v", registration, err)
	}
	if err = Refresh(state); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(content, []byte(unmanaged)) {
		t.Fatal("refresh changed an unmanaged LaunchAgent")
	}
}
