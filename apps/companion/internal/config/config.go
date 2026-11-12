package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type Config struct {
	Server     string `json:"server"`
	DeviceID   string `json:"deviceId"`
	Credential string `json:"credential"`
	Name       string `json:"name"`
	Slug       string `json:"slug"`
	CWD        string `json:"cwd"`
}

func DefaultStateDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "linux" {
		return filepath.Join(XDGDir("XDG_STATE_HOME", filepath.Join(home, ".local", "state")), "amita-companion"), nil
	}
	return filepath.Join(home, "Library", "Application Support", "Amita Companion"), nil
}

func EnsureDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	return os.Chmod(path, 0700)
}

func ConfigPath(state string) string { return filepath.Join(state, "config.json") }

func Save(state string, c Config) error {
	if err := EnsureDir(state); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := ConfigPath(state) + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(append(b, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err = os.Rename(tmp, ConfigPath(state)); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return syncDir(state)
}

func Load(state string) (Config, error) {
	var c Config
	if err := EnsureDir(state); err != nil {
		return c, err
	}
	path := ConfigPath(state)
	if err := os.Chmod(path, 0600); err != nil {
		return c, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	if c.Server == "" || c.DeviceID == "" || c.Credential == "" || c.Slug == "" || c.CWD == "" {
		return c, errors.New("pairing configuration is incomplete")
	}
	return c, nil
}

func NormalizeServer(raw string) (string, error) {
	u, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil {
		return "", err
	}
	if u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("server must be an origin or base URL")
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return "", errors.New("server must use HTTPS (HTTP is allowed only for loopback)")
	}
	if u.Path == "/" {
		u.Path = ""
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func Validate(c Config) error {
	if _, err := NormalizeServer(c.Server); err != nil {
		return fmt.Errorf("invalid server: %w", err)
	}
	if c.Name == "" {
		return errors.New("name is required")
	}
	return nil
}

// XDGDir ignores relative overrides, as required by the XDG specification.
func XDGDir(key, fallback string) string {
	if value := os.Getenv(key); filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	return fallback
}
