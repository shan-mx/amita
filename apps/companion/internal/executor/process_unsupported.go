//go:build !darwin && !linux

package executor

import (
	"errors"
	"os/exec"
)

func prepareProcess(*exec.Cmd) error {
	return errors.New("shell execution is supported only on macOS and Linux")
}
func killProcessGroup(*exec.Cmd) error {
	return errors.New("process groups are supported only on macOS and Linux")
}
