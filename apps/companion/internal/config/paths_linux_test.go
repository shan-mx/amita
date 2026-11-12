//go:build linux

package config

import (
	"path/filepath"
	"testing"
)

func TestLinuxDefaultStateDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, override := range []string{"", "relative", filepath.Join(home, "custom state")} {
		t.Setenv("XDG_STATE_HOME", override)
		want := filepath.Join(home, ".local", "state", "amita-companion")
		if filepath.IsAbs(override) {
			want = filepath.Join(override, "amita-companion")
		}
		got, err := DefaultStateDir()
		if err != nil || got != want {
			t.Fatalf("override %q: default = %q, %v; want %q", override, got, err, want)
		}
	}
}
