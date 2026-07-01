# 📓 Canvas Notebook — Self-Hosted AI Workspace

<p align="center">
  <strong>A self-hosted, container-first workspace with an AI agent at its core.</strong>
</p>

<p align="center">
  <a href="https://github.com/canvascoding/canvas-notebook/releases"><img src="https://img.shields.io/github/v/release/canvascoding/canvas-notebook?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Sustainable_Use_1.0-orange?style=for-the-badge" alt="Sustainable Use License 1.0"></a>
  <img src="https://img.shields.io/badge/Next.js-black?style=for-the-badge&logo=next.js&logoColor=white" alt="Next.js">
  <a href="https://ghcr.io/canvascoding/canvas-notebook"><img src="https://img.shields.io/badge/Docker-ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker"></a>
</p>

---

## What is Canvas Notebook?

Canvas Notebook is a self-hosted workspace for people who want an AI agent close to their real files, tools, and workflows. It combines a file browser, editor, terminal, chat, automations, to-dos, email, and creative AI tools in one container-first app.

Bring your workspace. Connect your preferred AI provider. Let the agent read, write, search, create, and automate without sending your whole operating system to a SaaS product.

---

## Why Canvas Notebook?

| You need | Canvas Notebook gives you |
|----------|---------------------------|
| A private AI workspace | Run it on your own VPS, homelab, or internal server |
| Agent work with real files | The agent can use your mounted `/data/workspace` directly |
| Provider choice | Use OpenRouter, Anthropic, Google Gemini, Ollama, Groq, Mistral, or OpenAI |
| Repeatable workflows | Turn recurring prompts into scheduled automations |
| Extensibility | Add custom skills with plain folders and `SKILL.md` files |
| Operational control | Update, restart, inspect logs, and reset admin access from the VM CLI |

---

## Built for

- **Creators and agencies** managing campaign assets, briefs, documents, image generations, and client work
- **Developers and operators** who want a browser-based workspace with terminal access and reproducible self-hosting
- **Teams with sensitive files** that need login protection, local storage, and explicit control over public sharing
- **Power users** who want AI chat, file operations, automations, email, and to-dos in one place

---

## Features

### Workspace Apps
- **Notebook** — files, chat, and editor in one focused workspace
- **Files** — browse, preview, upload, download, share, rename, move, and delete workspace files
- **To-dos** — track human tasks, approvals, and follow-ups that come out of agent work
- **Email** — connect inboxes, review messages, draft replies, and manage send policies
- **Studio** — manage products, personas, styles, presets, and AI-generated creative assets
- **Automations** — schedule recurring agent jobs for the workspace
- **Security** — review public file links and sharing exposure
- **Usage Analytics** — inspect token and cost usage across sessions, models, and users

### File Browser & Editor
- Browse, create, rename, move, and delete files and folders
- Upload and download files between your machine and the workspace
- **Markdown editor** with live preview
- **Code editor** with syntax highlighting for all common languages
- Document, spreadsheet, presentation, Excalidraw, HTML, and media previews
- Auto-save

### Viewers
- PDF documents, images, audio and video files — all viewable directly in the browser

### AI Agent
- Chat with an AI that has direct access to your workspace
- The agent can read and write files, run shell commands, search your notes, and execute tasks autonomously
- Conversations are persisted — pick up where you left off
- Agent settings, tools, managed prompt files, model selection, and runtime status live in the app
- **Skills** — drop a folder with a `SKILL.md` file into `/data/skills/` and the agent gains new capabilities. Skills can do things like generate images, process documents, run custom workflows, or anything else you define
- **Workflow automation** — tell the agent to run something on a schedule (once, daily, weekly, or at a custom interval) and it will

### Supported AI Providers
Connect with any of the following — API keys are configured at runtime inside the app, not required at startup:
- **OpenRouter** (access many models through one API)
- **Anthropic** (Claude)
- **Google Gemini**
- **Ollama** (run models locally, inside or alongside the container)
- Groq, Mistral, OpenAI

### Terminal
Full shell access in the browser — run commands, manage files, execute scripts.

### Language Support
The interface is fully translated — switch languages from the header or the onboarding wizard. Currently supported:
- **English**
- **German** (Deutsch)

### Authentication
- Login-protected by default
- No public signup or in-app user management
- The first admin can be created in the setup UI after first launch
- Admin access can also be created or reset from the VM host with the management CLI

---

## Install

### Linux / VPS (recommended)

One command on a fresh Ubuntu or Debian server:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install.sh)
```

The installer will:
1. Install **Docker** if it is missing
2. Auto-generate secrets and write the local config
3. Ask for the public URL/domain
4. Pull the latest pre-built image from `ghcr.io` and start the container
5. Install the host-side `canvas-notebook` management command and systemd service
6. Optionally install and configure **Caddy** for automatic HTTPS, only if you choose it

By default, Caddy is not installed. If you skip it, Canvas Notebook runs on port **3456** and you can put it behind your own reverse proxy or access it directly according to your server setup.

If you enable Caddy, open ports **80** and **443** at your provider and point an A record for your domain to your server IP before the first request. Caddy then handles the Let's Encrypt certificate automatically and keeps port 3456 internal.

After installation, manage the VM from any directory with:

```bash
canvas-notebook help
canvas-notebook update
canvas-notebook logs
canvas-notebook status
canvas-notebook restart
canvas-notebook admin reset-password --email admin@example.com
```

The CLI runs on the VM host, not inside the app container. It remembers the install directory and Compose file, so you do not need to `cd` into the project folder or run Docker Compose commands manually.

---

### Docker Compose (pre-built image, SQLite)

Clone the repo and use the included `compose.ghcr.yaml` to run the pre-built image with SQLite:

```bash
git clone https://github.com/canvascoding/canvas-notebook.git
cd canvas-notebook
cp .env.docker.example .env.docker.local
# Edit .env.docker.local and fill in the REQUIRED section
docker compose -f compose.ghcr.yaml up -d
```

The app will be available at `http://localhost:3456`. Open it in your browser and create the first admin account on the setup page, then follow the onboarding wizard.

---

### Hosting platforms (Coolify, EasyPanel, Portainer, etc.)

Use the included `compose.coolify.yaml` which sets up the app with a Postgres database and all required environment variables with sensible defaults:

1. Point your platform to this repository and select `compose.coolify.yaml` as the Compose file
2. Set the following environment variables in your platform's env editor:
   - `BASE_URL` — your public domain, e.g. `https://canvas.example.com`
   - `BETTER_AUTH_SECRET` — random secret (`openssl rand -base64 32`)
   - `CANVAS_INTERNAL_API_KEY` — random secret (`openssl rand -base64 32`)
   - `CANVAS_POSTGRES_PASSWORD` — change the default password before production use
3. Deploy — the platform handles the rest (volumes, networking, SSL)

---

## Your Data

All data is stored in a `./data` directory on the host, mounted into the container at `/data`. It is never lost when the container is updated, restarted, or rebuilt.

| Path | What lives here |
|------|----------------|
| `/data/workspace` | Your files |
| `/data/sqlite.db` | Database (sessions, users, chat history) |
| `/data/skills/` | Custom agent skills |
| `/data/secrets/` | Integration tokens and secrets |

---

## Update

On Linux / VPS installs, update from anywhere on the VM:

```bash
canvas-notebook update
```

This pulls the latest image, recreates the container, streams startup logs, and waits until the app is healthy. Your data is untouched because it lives in the host `./data` directory.

For local / from-source installs:

```bash
git pull
npm run setup
```

---

## Configuration

The Linux installer generates the secrets and writes the required values for you. If you run the container manually, provide at least:

| Variable | Required | Description |
|----------|----------|-------------|
| `BASE_URL` | **Yes** | Public URL of the app, e.g. `https://canvas.example.com` |
| `BETTER_AUTH_BASE_URL` | **Yes** | Public URL of the app for auth (usually the same as `BASE_URL`) |
| `BETTER_AUTH_SECRET` | **Yes** | Random 32-byte base64 secret — auto-generated by the installer |
| `CANVAS_INTERNAL_API_KEY` | **Yes** | Internal API secret — auto-generated by the installer |

All other values (port, data path, database provider, logging) have sensible defaults baked into the pre-built image and the app itself. See `.env.docker.example` for the full list of optional settings.

Create the first admin in the setup UI, or use `canvas-notebook admin reset-password --email ... --password-stdin` on the VM host.

AI provider API keys (Claude, OpenRouter, Gemini, etc.) are configured inside the running app — you don't need them here.

---

## VM Management CLI

The Linux installer creates a host-side `/usr/local/bin/canvas-notebook` command. It can be run from any directory:

```bash
canvas-notebook help
canvas-notebook install
canvas-notebook update
canvas-notebook logs
canvas-notebook status
canvas-notebook restart
canvas-notebook stop
canvas-notebook start
canvas-notebook health
canvas-notebook admin reset-password --email admin@example.com
```

Run these commands on the VM/server, not inside the app container. The CLI stores the install directory and Compose file path during setup, so it can manage the container without you being in the right folder.

`admin reset-password` resets or creates the admin login in the running container without writing the password to `config.json`, `.env`, or Compose files. For automation, pass the password over stdin with `--password-stdin`.

---

## Skills

Skills extend what the AI agent can do. A skill is a folder with a `SKILL.md` file:

```
/data/skills/
  my-skill/
    SKILL.md          # name, description, and instructions for the agent
    bin/my-skill      # optional: executable makes this skill a callable tool
```

```yaml
---
name: my-skill
description: "What this skill does and when to use it"
---

Instructions for the agent...
```

Skills without an executable are loaded as context into the agent's system prompt. Skills with a `bin/` executable become callable tools the agent can invoke directly.

---

## Development

To build and run from source, use the local development Compose file in `dev/`:

```bash
git clone https://github.com/canvascoding/canvas-notebook.git
cd canvas-notebook
npm run setup          # builds image via dev/compose.yaml and starts container

npm run dev            # local dev server (no Docker)
npm run lint
npm run test:all
```

Pre-built images are published automatically to `ghcr.io/canvascoding/canvas-notebook` when a new release tag is pushed.

---

## Star History

<a href="https://www.star-history.com/?repos=canvascoding%2Fcanvas-notebook&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=canvascoding/canvas-notebook&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=canvascoding/canvas-notebook&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=canvascoding/canvas-notebook&type=date&legend=top-left" />
 </picture>
</a>

---

## License

Sustainable Use License © [Frank Alexander Weber](https://github.com/canvascoding)
