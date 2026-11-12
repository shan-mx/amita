# Amita

Amita is a self-hosted personal agent. Work from the browser or Telegram, run commands and manage files on paired computers, and schedule prompts or scripts with Automations. Each Agent has its own conversations, Markdown memory, and workspace. Accepted tasks run independently of the browser connection.

## Quick start

Deploy to your Cloudflare account from macOS, Linux, or WSL 2:

```sh
git clone https://github.com/shan-mx/amita.git
cd amita
./amita setup
```

The script installs Vite+ (`vp`) when needed, uses it to prepare Node.js and pnpm, signs in to Cloudflare, asks for your Owner password, generates a credential encryption key, and deploys the app. You do not need to install Node.js or pnpm manually. Deployment does not require Go. Sign in at the printed URL, connect a provider in **Providers**, and choose a model when creating your first Agent. See [Deployment and persistence](docs/deployment.md) for updates and removal.

For local development, follow [Getting started](docs/getting-started.md). Pair a Companion when you want the Agent to work with local files or commands.

## Guides

| Task                                                         | Guide                                      |
| ------------------------------------------------------------ | ------------------------------------------ |
| Install, chat, pair a computer, or choose development checks | [Getting started](docs/getting-started.md) |
| Use files, Code Mode, memory, or Automations                 | [Tools and execution](docs/tools.md)       |
| Deploy to Cloudflare or connect Telegram                     | [Deployment](docs/deployment.md)           |
| Understand channel routing, attachments, and delivery        | [Channels](docs/channels.md)               |
| Find code and data owners                                    | [Architecture](docs/architecture.md)       |
| Change the web interface                                     | [Frontend maintenance](docs/frontend.md)   |

The Companion supports macOS, Linux, and WSL 2 and runs with its OS user's permissions. See [requirements](docs/getting-started.md#requirements) before building.

Released under the [MIT License](LICENSE).
