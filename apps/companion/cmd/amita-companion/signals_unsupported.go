//go:build !darwin && !linux

package main

import "os"

func shutdownSignals() []os.Signal { return []os.Signal{os.Interrupt} }
