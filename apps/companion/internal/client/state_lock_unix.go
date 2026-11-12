//go:build darwin || linux

package client

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

type stateLock struct{ file *os.File }

func acquireStateLock(stateDir string) (*stateLock, error) {
	file, err := os.OpenFile(filepath.Join(stateDir, "state.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = file.Chmod(0600); err != nil {
		_ = file.Close()
		return nil, err
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("another Companion process already owns this state directory: %w", err)
	}
	return &stateLock{file}, nil
}
func (l *stateLock) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	_ = syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	return l.file.Close()
}
