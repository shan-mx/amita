# Getting started

## Requirements

These requirements are for local development. To deploy to Cloudflare with automatic Node.js and pnpm setup and no Go requirement, use the [deployment CLI](deployment.md#first-deployment).

- Node.js 24.11 or later in the 24.x line and pnpm 12; use the pnpm version in [package.json](../package.json).
- Go 1.25 or later to build or check the Companion. Supported systems: macOS, Linux, and WSL 2. [Go module](../apps/companion/go.mod)
- An API key for a built-in provider or a custom service supporting OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, or Google Gemini.

## Start the app and send a message

```sh
git clone https://github.com/shan-mx/amita.git
cd amita
pnpm install --frozen-lockfile
cp -n .dev.vars.example .dev.vars
```

1. Set `AMITA_OWNER_PASSWORD` in `.dev.vars`. Generate an encryption key once with `openssl rand -base64 32` and set `AMITA_CREDENTIAL_ENCRYPTION_KEY` to that value. Keep a secure copy outside the database and reuse it after restarts.
2. Run `pnpm dev` from the repository root. The app and main Worker use port 5173; the Code Mode Sandbox uses 8788.
3. Open [the local app](http://127.0.0.1:5173) and sign in with the Owner password.
4. In **Providers**, select a built-in provider and enter its API key, or add a custom provider with its protocol, base URL, and model profiles. OpenAI protocols support model discovery; enter missing token limits manually. Custom Anthropic and Gemini profiles are entered manually. Saving a connection does not test the upstream key.
5. Select **New agent**, choose its model, and enter a name, Slug, and optional Persona. The Slug identifies its workspace and stays fixed. **Agent settings** and **Memory** are in the Agent menu.
6. Send a message and confirm a reply. Wait for the connection if the composer shows **Reconnecting…**.

Each Agent supplies the model for new Web and Channel sessions. Existing sessions retain their own model; change it below the message box while idle. Model switching is disabled during a task. See [Automations](tools.md#automations) for scheduled tasks and their model selection.

Local data lives in `.wrangler/state`. Keep acceptance data separate from your normal development state.

## Pair and run the Companion

Build on the target computer from the repository root:

```sh
node scripts/companion.ts build
```

1. Open **Computers** and select **Generate registration code**. Codes expire after five minutes.
2. Run the displayed command. For a local build:

   ```sh
   ./apps/companion/amita-companion pair --server http://127.0.0.1:5173 --code REGISTRATION_CODE --name "My Computer"
   ```

3. Leave the command running. In **Computers**, assign a Slug such as `macbook` and select **Confirm pairing**. The command saves the credentials and exits.
4. Start the Companion and wait for the device to appear online:

   ```sh
   ./apps/companion/amita-companion run
   ```

The local app listens on loopback; pair from the same environment. For production, use the app's HTTPS origin as `--server`. Build the Worker and Companion from the same revision.

Ask the Agent to write and read a temporary file under `/computers/macbook/workspace/`. This maps to `~/.amita/workspaces/<agent-slug>/` on that computer. [Paths and tools](tools.md#computer-and-workspace)

## Manage the Companion

Stop the foreground process before starting a background instance:

```sh
./apps/companion/amita-companion start
./apps/companion/amita-companion status
./apps/companion/amita-companion logs -f
```

Use `stop` or `restart` to control the process and `run` or `start --foreground` to debug. In `status`, `running` describes the local process, `connected` its server connection, and `autostart` its login registration.

```sh
./apps/companion/amita-companion autostart enable
./apps/companion/amita-companion autostart status
./apps/companion/amita-companion autostart disable
```

Autostart installs a binary copy and records the current PATH. It takes effect at the next login: launchd on macOS, a systemd user unit on Linux, or XDG autostart on Linux desktops without a user manager. Disabling autostart leaves the current process running; stopping the process preserves registration. `install` also enables autostart. `uninstall` stops the process and removes the registration and installed binary, preserving pairing data. Revoke server authorization in **Computers**.

| System        | Default state directory                                                |
| ------------- | ---------------------------------------------------------------------- |
| macOS         | `~/Library/Application Support/Amita Companion`                        |
| Linux / WSL 2 | `$XDG_STATE_HOME/amita-companion`, or `~/.local/state/amita-companion` |

Logs are in `companion.log`; startup errors may appear in `companion.stderr.log`. For isolated development, pass the same `--state-dir` to every command. Pairing's `--cwd` sets the directory reported to the server; Agent tools default to the Agent workspace.

### WSL 2

Build the Linux binary inside each target distribution and pair distributions separately. Use Linux paths, including `/mnt/c/...` for Windows files. Keep Companion state and projects requiring Unix filesystem semantics inside the distribution.

For autostart, enable systemd, restart the distribution, and verify `systemctl --user show-environment` before running `autostart enable`. Keep the distribution active while using the Companion. [WSL systemd setup](https://learn.microsoft.com/en-us/windows/wsl/systemd) · [WSL lifecycle](https://devblogs.microsoft.com/commandline/systemd-support-is-now-available-in-wsl/)

## Troubleshooting

| Symptom                     | Check                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Service not configured      | Check the Owner password and restart local services. Provider credential errors require the encryption key. |
| Chat works; Code Mode fails | Start `pnpm dev` from the root and check Sandbox logs on port 8788.                                         |
| Pairing expires             | Generate a new code and confirm the pending device while the command waits.                                 |
| Device offline              | Check `status`, then `logs` and startup errors. Verify the server origin and authorization.                 |

## Development checks

Run only the checks relevant to your change, from the repository root.

| Change              | Check                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown            | `pnpm exec vp fmt --check <files>`; check links and examples.                                                                                |
| Workspace code      | `pnpm check` for lint, TypeScript, and Go vet.                                                                                               |
| Worker behavior     | Build the Sandbox with `pnpm exec vp run @amita/codemode-sandbox#build`, then run `pnpm exec vp test --config vitest.config.ts <test-file>`. |
| Browser interaction | `pnpm test:web`; see [frontend verification](frontend.md#verification).                                                                      |
| Build or deployment | `pnpm build`.                                                                                                                                |
| Companion           | `node scripts/companion.ts check`, `test`, or `build`.                                                                                       |
| Full test suite     | `pnpm test` for Worker and Companion tests.                                                                                                  |

Automated tests use model and device fixtures. Validate real chat and file operations with temporary data and a separate Companion state directory.
