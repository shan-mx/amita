package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/shan-mx/amita/apps/companion/internal/config"
)

func Pair(ctx context.Context, server, code, name, cwd string, waiting func()) (config.Config, error) {
	base, err := config.NormalizeServer(server)
	if err != nil {
		return config.Config{}, err
	}
	if strings.TrimSpace(code) == "" || strings.TrimSpace(name) == "" {
		if strings.TrimSpace(code) == "" {
			return config.Config{}, errors.New("code is required")
		}
		name, err = os.Hostname()
		if err != nil {
			return config.Config{}, err
		}
	}
	if cwd == "" {
		cwd, err = os.UserHomeDir()
		if err != nil {
			return config.Config{}, err
		}
	}
	body, _ := json.Marshal(map[string]string{"code": code, "name": name})
	endpoint := base + "/api/companion/register"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return config.Config{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	c := http.Client{Timeout: 20 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 0 && !sameOrigin(via[0].URL, req.URL) {
			req.Header.Del("Authorization")
			return http.ErrUseLastResponse
		}
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return nil
	}}
	resp, err := c.Do(req)
	if err != nil {
		return config.Config{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return config.Config{}, fmt.Errorf("registration failed (%s): %s", resp.Status, strings.TrimSpace(string(b)))
	}
	var result struct {
		DeviceID   string `json:"deviceId"`
		Credential string `json:"credential"`
		ExpiresAt  int64  `json:"expiresAt"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&result); err != nil {
		return config.Config{}, err
	}
	if result.DeviceID == "" || result.Credential == "" || result.ExpiresAt == 0 {
		return config.Config{}, errors.New("registration response is incomplete")
	}
	if waiting != nil {
		waiting()
	}
	deadline, cancel := context.WithDeadline(ctx, time.UnixMilli(result.ExpiresAt))
	defer cancel()
	slug, err := waitForConfirmation(deadline, &c, base, result.DeviceID, result.Credential)
	if err != nil {
		return config.Config{}, err
	}
	return config.Config{Server: base, DeviceID: result.DeviceID, Credential: result.Credential, Name: name, Slug: slug, CWD: cwd}, nil
}

const pairingPollInterval = 1500 * time.Millisecond

func waitForConfirmation(ctx context.Context, c *http.Client, base, deviceID, credential string) (string, error) {
	for {
		if err := ctx.Err(); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return "", errors.New("pairing confirmation expired. Generate a new registration code")
			}
			return "", err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/companion/status", nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("Authorization", "Bearer "+credential)
		resp, err := c.Do(req)
		if err == nil {
			var status struct {
				State    string `json:"state"`
				DeviceID string `json:"deviceId"`
				Slug     string `json:"slug"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&status)
			resp.Body.Close()
			if resp.StatusCode == http.StatusForbidden {
				return "", errors.New("pairing was cancelled, revoked or expired")
			}
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				if decodeErr != nil {
					return "", decodeErr
				}
				if status.DeviceID != deviceID {
					return "", errors.New("pairing identity does not match")
				}
				switch status.State {
				case "active":
					if status.Slug == "" {
						return "", errors.New("confirmed pairing has no Computer Slug")
					}
					return status.Slug, nil
				case "pending":
				default:
					return "", errors.New("pairing was cancelled or revoked")
				}
			} else if resp.StatusCode < 500 && resp.StatusCode != http.StatusTooManyRequests {
				return "", fmt.Errorf("pairing status failed (%s)", resp.Status)
			}
		}
		timer := time.NewTimer(pairingPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}
