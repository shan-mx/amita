//go:build !darwin && !linux

package service

func enable(string, string) error          { return errUnsupported }
func refresh(string, string) error         { return errUnsupported }
func Inspect(string) (Registration, error) { return Registration{}, errUnsupported }
func Disable(string) error                 { return errUnsupported }
func Status(string) (bool, error)          { return false, errUnsupported }
