package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPairWaitsForConfirmationWithoutRegisteringTwice(t *testing.T) {
	var registrations, polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/companion/register" {
			registrations.Add(1)
			json.NewEncoder(w).Encode(map[string]any{"deviceId": "device", "credential": "secret", "expiresAt": time.Now().Add(10 * time.Second).UnixMilli()})
			return
		}
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("missing device authentication")
		}
		state := "pending"
		if polls.Add(1) >= 2 {
			state = "active"
		}
		json.NewEncoder(w).Encode(map[string]string{"deviceId": "device", "state": state, "slug": "macbook"})
	}))
	defer server.Close()
	waiting := false
	result, err := Pair(context.Background(), server.URL, "code", "My Mac", "/work", func() { waiting = true })
	if err != nil {
		t.Fatal(err)
	}
	if !waiting || registrations.Load() != 1 || polls.Load() != 2 || result.Slug != "macbook" || result.DeviceID != "device" {
		t.Fatalf("unexpected pair result: %#v", result)
	}
}
func TestPairCancellationAndExpiryNeverReturnUsableConfig(t *testing.T) {
	for _, mode := range []string{"revoked", "expired", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/companion/register" {
					expiry := time.Now().Add(time.Minute)
					if mode == "expired" {
						expiry = time.Now().Add(-time.Second)
					}
					json.NewEncoder(w).Encode(map[string]any{"deviceId": "device", "credential": "secret", "expiresAt": expiry.UnixMilli()})
					return
				}
				w.WriteHeader(http.StatusForbidden)
			}))
			defer server.Close()
			result, err := Pair(ctx, server.URL, "code", "Mac", "", func() {
				if mode == "cancelled" {
					cancel()
				}
			})
			if err == nil || result.Credential != "" {
				t.Fatalf("unconfirmed config escaped: %#v %v", result, err)
			}
			if mode == "expired" && !strings.Contains(err.Error(), "expired") {
				t.Fatal(err)
			}
		})
	}
}
