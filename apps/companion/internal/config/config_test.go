package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveUsesPrivatePermissionsAndRoundTripsCredential(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private", "state")
	want := Config{Server: "https://example.test", DeviceID: "device-1", Credential: "opaque-secret", Name: "Mac", Slug: "mac", CWD: "/Users/test"}
	if err := Save(dir, want); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0700 {
		t.Fatalf("state permissions = %o", st.Mode().Perm())
	}
	st, err = os.Stat(ConfigPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0600 {
		t.Fatalf("config permissions = %o", st.Mode().Perm())
	}
	got, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("round trip = %#v, want %#v", got, want)
	}
}

func TestNormalizeServerRejectsNonLoopbackHTTP(t *testing.T) {
	for _, raw := range []string{"http://example.test", "http://192.168.1.2"} {
		if _, err := NormalizeServer(raw); err == nil {
			t.Fatalf("accepted insecure server %q", raw)
		}
	}
	if got, err := NormalizeServer("http://127.0.0.1:8787/"); err != nil || got != "http://127.0.0.1:8787" {
		t.Fatalf("loopback = %q, %v", got, err)
	}
}

func TestXDGDirectoryRejectsRelativeOverrides(t *testing.T) {
	for _, value := range []string{"", "relative/state"} {
		t.Setenv("XDG_STATE_HOME", value)
		if got := XDGDir("XDG_STATE_HOME", "/home/user/.local/state"); got != "/home/user/.local/state" {
			t.Fatalf("relative override resolved to %q", got)
		}
	}
	t.Setenv("XDG_STATE_HOME", "/var/state/../private")
	if got := XDGDir("XDG_STATE_HOME", "/fallback"); got != "/var/private" {
		t.Fatalf("absolute override = %q", got)
	}
}

func TestLoadRejectsIncompletePairing(t *testing.T) {
	for _, tc := range []struct{ name, slug, cwd string }{
		{name: "missing Slug", cwd: "/Users/test"},
		{name: "missing working directory", slug: "mac"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			c := Config{Server: "https://example.test", DeviceID: "device", Credential: "fixture", Name: "Mac", Slug: tc.slug, CWD: tc.cwd}
			if err := Save(dir, c); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(dir); err == nil {
				t.Fatal("loaded incomplete pairing configuration")
			}
		})
	}
}
