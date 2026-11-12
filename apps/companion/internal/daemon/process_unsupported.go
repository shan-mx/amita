//go:build !darwin && !linux

package daemon

import (
	"errors"
	"os/exec"
)

func detach(*exec.Cmd) error {
	return errors.New("Companion runtime is supported only on macOS and Linux")
}
func connectionRefused(error) bool { return false }
