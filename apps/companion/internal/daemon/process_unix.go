//go:build darwin || linux

package daemon

import (
	"errors"
	"os/exec"
	"syscall"
)

func detach(cmd *exec.Cmd) error       { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}; return nil }
func connectionRefused(err error) bool { return errors.Is(err, syscall.ECONNREFUSED) }
