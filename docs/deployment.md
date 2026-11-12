# Deployment and persistence

Amita uses two Cloudflare Workers: `amita` serves the web app and API; `amita-codemode-sandbox` hosts QuickJS. Use an account with access to both Workers and their Durable Objects. [Main configuration](../wrangler.jsonc) · [Sandbox configuration](../apps/codemode-sandbox/wrangler.jsonc)

## First deployment

Start with a fresh deployment of Amita v0.1.0 and build the Companion from the same release. Keep existing deployments on the legacy checkout and use its matching Companion.

Clone the repository and run its interactive setup script on macOS, Linux, or WSL 2:

```sh
git clone https://github.com/shan-mx/amita.git
cd amita
./amita setup
```

You need Git and Bash. If Vite+ (`vp`) is not available, the script installs it using the official installer, which requires `curl` and `tar`. Vite+ prepares Node.js and pnpm using the versions declared in [package.json](../package.json), so neither needs to be installed manually. Deployment does not require Go. Local development keeps its existing [requirements](getting-started.md#requirements).

Setup installs the locked dependencies, opens Wrangler's Cloudflare login when needed, and lets you select an account. Enter your Owner password using the hidden input. The script generates the provider credential encryption key and uploads it with the password as Worker Secrets.

Setup is for a fresh deployment. If either target Worker already exists, it stops and asks you to use `./amita update`, which preserves the existing encryption key and stored credentials. Once you enter the Owner password, the CLI builds the Web app and both Workers, then deploys the Sandbox followed by the main Worker. Wrangler may ask you to register a workers.dev subdomain. Its output includes the main Worker's URL. The temporary private Secrets file is removed after the deployment attempt.

After deployment, sign in, connect a provider in **Providers**, and choose a model when creating an Agent. Provider URLs and API keys are configured in the Web UI. Companion pairing uses the existing [pairing flow](getting-started.md#pair-and-run-the-companion).

### Manual deployment for developers

You can also deploy with the development toolchain. From the repository root, install dependencies, sign in to Wrangler, and check the active Cloudflare account:

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec vp run @amita/web#build
```

Prepare a private JSON file outside the repository with `AMITA_OWNER_PASSWORD` and `AMITA_CREDENTIAL_ENCRYPTION_KEY`. Generate the encryption key once with `openssl rand -base64 32` (32 random bytes, Base64 encoded). Keep a secure backup outside the database and retain the same value across deployments.

Deploy the Sandbox before the main Worker:

```sh
pnpm exec wrangler deploy --config dist/codemode/wrangler.json
pnpm exec wrangler deploy --config dist/amita/wrangler.json --secrets-file /absolute/path/to/amita-secrets.json
```

The build produces `dist/client`, `dist/amita`, and `dist/codemode`. Each Worker has an initial `v1` migration: the main Worker creates SQLite namespaces for `Deployment`, `Agent`, and `Computer`; the Sandbox creates its own. If you rename the Sandbox Worker, update the main Worker's `CODEMODE_SANDBOX.script_name` binding.

Sign in, connect a built-in or custom provider in **Providers**, and choose a model when creating each Agent. See [getting started](getting-started.md#pair-and-run-the-companion) to build and pair a matching Companion.

## Redeploy the Workers

From a clean checkout of `main`, run:

```sh
./amita update
```

Update fast-forwards your checkout to the latest `origin/main`, prepares its declared Node.js and pnpm versions through `vp` and installs the locked dependencies, and asks you to select the target Cloudflare account. After confirmation it builds and deploys the Sandbox followed by the main Worker. Existing remote Secrets and application data are retained. Provider connections, model selections, and paired computers are retained.

Tracked local changes, a different branch, or diverged Git history stop the update. Commit or discard your changes and resolve the branch before trying again; the CLI does not automatically stash, rebase, or reset your checkout.

To redeploy your current checkout using the developer toolchain, run:

```sh
pnpm run deploy
```

This builds the workspace, deploys the Sandbox, then deploys the main Worker. To deploy only the Workers, use the web build and two deploy commands above. Omit `--secrets-file` to retain configured secrets.

## Remove the deployment

```sh
./amita destroy
```

Select the Cloudflare account and review the displayed Worker names and data deletion scope. Confirm the overall deletion, then confirm Wrangler's individual Worker deletions. The CLI requests deletion of the main Worker before the Sandbox and retains Wrangler's dependency checks without `--force`.

Deletion removes the Workers, their Secrets, and their owned Durable Object data, including conversations, settings, Automations, and computer registrations. This cannot be undone. The CLI keeps your local checkout, Vite+ installation and managed tools, and Wrangler login. Cancel at the overall confirmation to leave both Workers unchanged; Ctrl+C stops the command during Wrangler's individual confirmations.

## CLI checks

`pnpm test:cli` runs the CLI's terminal behavior tests under Node.js using the system `script` utility on macOS and Linux. CI starts from a Debian container without Node.js, pnpm, Bun, or Go, installs `vp`, prepares the declared Node.js and pnpm versions, installs locked dependencies, runs the CLI tests and type checks, builds the Web app and both Workers, and performs Wrangler deployment dry-runs. `pnpm-lock.yaml` remains the only dependency lockfile.

## Manage providers and credentials

Configure provider URLs, model profiles, and API keys in the signed-in Web UI. See [getting started](getting-started.md#start-the-app-and-send-a-message) for provider types and model profiles. Saving a connection does not validate its upstream key; the first model request does.

Removing a provider preserves chats and automation definitions, showing affected model references as unavailable until you choose another model. See [model ownership](architecture.md#data-ownership) and [Automation behavior](tools.md#automations) for selection rules.

Provider API keys are encrypted with AES-GCM in the Deployment DO. The master key stays in the Worker Secret and must decode from Base64 to 16, 24, or 32 bytes. Sign-in and history access require only the Owner password; saving new credentials, making model requests, and discovering models with a saved key require the master key. If it is lost, restore the backup or re-enter provider keys under a new master key. Replacing it without re-encrypting stored credentials makes those credentials unreadable.

## Storage and schema

The Deployment DO applies Drizzle migrations before serving requests. To change its schema, run `pnpm db:generate` and commit the generated SQL, metadata, and migration entry point with the schema. Other state belongs to the respective DO or Pi runtime. [Data ownership](architecture.md#data-ownership) · [Schema](../packages/db/src/schema.ts) · [Migrations](../packages/db/drizzle)

Keep secrets and device credentials outside the repository. Login tokens are stored as hashes. Production cookies are HttpOnly, Secure, and SameSite=Strict, with a 30-day lifetime. oRPC accepts same-origin JSON POST requests. Login attempts have an approximate limit of three per minute per IP at each Cloudflare location.

## Verify a deployment

1. Sign in and confirm a real chat reply.
2. Ask the Agent to calculate `6 * 7` using Code Mode and inspect the tool result.
3. Pair a Companion, confirm it is online, and read a temporary file.

For configuration errors, check the Owner password, credential encryption key, and saved provider connection. For Code Mode errors, inspect both Workers' logs and the Sandbox binding. For device errors, use the [Companion checks](getting-started.md#troubleshooting).

## Connect Telegram

1. Open Amita over public HTTPS and select an Agent.
2. In **Channels**, enter a bot token and connect it to register the webhook.
3. Open the pairing link and select **Start** in the bot's private chat.
4. For automatic Topics, enable Threaded Mode and user Topic creation in BotFather. Attachments require an online Companion.

Connecting replaces the bot's existing webhook; use a dedicated test bot for acceptance. Multiple bots can share the deployment's paired Owner. [Channel behavior](channels.md) · [Channel tools](tools.md#channels)
