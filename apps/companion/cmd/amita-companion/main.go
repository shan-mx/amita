package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"github.com/shan-mx/amita/apps/companion/internal/client"
	"github.com/shan-mx/amita/apps/companion/internal/config"
	"github.com/shan-mx/amita/apps/companion/internal/daemon"
	"github.com/shan-mx/amita/apps/companion/internal/service"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "amita-companion:", err)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 0 {
		return usage()
	}
	command := args[0]
	action := ""
	flagArgs := args[1:]
	if command == "autostart" {
		if len(flagArgs) == 0 {
			return usage()
		}
		action = flagArgs[0]
		flagArgs = flagArgs[1:]
	}
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	defaultState, err := config.DefaultStateDir()
	if err != nil {
		return err
	}
	state := fs.String("state-dir", defaultState, "state directory")
	server := fs.String("server", "", "Amita server URL")
	code := fs.String("code", "", "one-time registration code")
	name := fs.String("name", "", "computer name")
	cwd := fs.String("cwd", "", "default working directory")
	foreground := fs.Bool("foreground", false, "Run in the foreground instead of background")
	follow := fs.Bool("f", false, "Follow log output")
	lines := fs.Int("n", daemon.DefaultLogLines, "Number of lines to show")
	if err = fs.Parse(flagArgs); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return usage()
	}
	absState, err := filepath.Abs(*state)
	if err != nil {
		return err
	}
	switch command {
	case "pair":
		if *server == "" || *code == "" {
			return errors.New("pair requires --server and --code")
		}
		if *name == "" {
			*name, err = os.Hostname()
			if err != nil {
				return err
			}
		}
		if *cwd != "" {
			*cwd, err = filepath.Abs(*cwd)
			if err != nil {
				return err
			}
		}
		ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
		defer stop()
		c, err := client.Pair(ctx, *server, *code, *name, *cwd, func() {
			fmt.Println("Waiting for confirmation in Amita. Open Computers to confirm the Computer Slug.")
		})
		if err != nil {
			return err
		}
		if err = config.Save(absState, c); err != nil {
			return err
		}
		fmt.Printf("Paired computer %q (%s).\n", c.Name, c.Slug)
		return nil
	case "run", "start", "restart":
		c, err := config.Load(absState)
		if err != nil {
			return fmt.Errorf("not paired: %w", err)
		}
		if command == "restart" {
			if err = daemon.Stop(absState); err != nil {
				return err
			}
		}
		if command == "run" || *foreground {
			ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
			defer stop()
			return daemon.Run(ctx, absState, c, os.Getenv(service.ManagedEnv) == "1")
		}
		if err = service.Refresh(absState); err != nil {
			fmt.Fprintln(os.Stderr, "Could not refresh login autostart:", err)
		}
		binary, err := os.Executable()
		if err != nil {
			return err
		}
		if err = daemon.Start(absState, binary); err != nil {
			return err
		}
		fmt.Println("Started Companion.")
		if registration, err := service.Inspect(absState); err == nil && !registration.Enabled {
			fmt.Println("Enable login autostart with 'amita-companion autostart enable'.")
		}
		return nil
	case "install", "autostart":
		switch {
		case command == "install" || action == "enable":
			if _, err := config.Load(absState); err != nil {
				return fmt.Errorf("pair before installing: %w", err)
			}
			binary, err := os.Executable()
			if err != nil {
				return err
			}
			if err = service.Enable(absState, binary); err != nil {
				return err
			}
			if command == "install" {
				fmt.Println("Installed Companion and enabled login autostart.")
			} else {
				fmt.Println("Enabled login autostart.")
			}
			return nil
		case action == "disable":
			if err = service.Disable(absState); err != nil {
				return err
			}
			fmt.Println("Disabled login autostart.")
			return nil
		case action == "status":
			registration, err := service.Inspect(absState)
			if err != nil {
				return err
			}
			return printJSON(registration)
		default:
			return usage()
		}
	case "stop":
		if err = daemon.Stop(absState); err != nil {
			return err
		}
		fmt.Println("Stopped Companion.")
		return nil
	case "logs":
		ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
		defer stop()
		return daemon.Logs(ctx, absState, *lines, *follow, os.Stdout)
	case "status":
		c, loadErr := config.Load(absState)
		current, err := daemon.Query(absState)
		if err != nil {
			return err
		}
		registration, err := service.Inspect(absState)
		if err != nil {
			return err
		}
		serviceRunning := false
		if current.Managed || (registration.Present && registration.Mechanism != "xdg") {
			serviceRunning, err = service.Status(absState)
			if err != nil {
				return err
			}
		}
		return printJSON(map[string]any{"paired": loadErr == nil, "name": c.Name, "slug": c.Slug, "serviceRunning": serviceRunning, "running": current.Running, "connected": current.Connected, "pid": current.PID, "autostart": registration})
	case "uninstall":
		if err = daemon.Stop(absState); err != nil {
			return err
		}
		if err = service.Uninstall(absState); err != nil {
			return err
		}
		fmt.Println("Removed login autostart and the installed binary; pairing configuration was preserved.")
		return nil
	default:
		return usage()
	}
}
func usage() error {
	return errors.New("usage: amita-companion <pair|run|install|start|stop|restart|status|logs|uninstall> [flags]; amita-companion autostart <enable|disable|status> [flags]")
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
