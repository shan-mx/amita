//go:build !darwin && !linux

package client

import "errors"

type stateLock struct{}

func acquireStateLock(string) (*stateLock, error) {
	return nil, errors.New("Companion runtime is supported only on macOS and Linux")
}
func (*stateLock) Close() error { return nil }
