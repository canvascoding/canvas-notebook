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

Canvas Notebook is a personal workspace that lives in a container. Think of it as a notebook that can read, write, search, and create files — with an AI you can actually talk to. You bring your files, the agent does the work.

---

## Features

### File Browser & Editor
- Browse, create, rename, move, and delete files and folders
- Upload and download files between your machine and the workspace
- **Markdown editor** with live preview
- **Code editor** with syntax highlighting for all common languages
- Auto-save

### Viewers
- PDF documents, images, audio and video files — all viewable directly in the browser

### AI Agent
- Chat with an AI that has direct access to your workspace
- The agent can read and write files, run shell commands, search your notes, and execute tasks autonomously
- Conversations are persisted — pick up where you left off
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

### Spreadsheet Viewer
View Excel and CSV files directly, no downloads needed.

### Language Support
The interface is fully translated — switch languages from the header or the onboarding wizard. Currently supported:
- **English**
- **German** (Deutsch)

### Authentication
- Login-protected by default
- No public signup or in-app user management
- The bootstrap admin is created or synchronized from env vars on every start

---

## Install

### Linux / VPS (recommended)

One command on a fresh Ubuntu or Debian server:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install.sh)
```

The installer will:
1. Install **Docker** (and optionally **Caddy** for automatic HTTPS)
2. Pull the latest pre-built image from `ghcr.io` — no build step, no Node.js needed
3. Auto-generate secrets
4. Ask you to set your email, password, and public URL
5. Start the container
6. Configure Caddy with a Let's Encrypt TLS certificate automatically

**Firewall:** open ports **80** and **443** at your provider. Port 3456 stays internal behind Caddy.

**DNS:** point an A record for your domain to your server IP before the first request — Caddy handles the certificate automatically.

#### Non-interactive / launch script

All prompts can be bypassed with environment variables — useful when provisioning a new instance automatically:

```bash
INSTALL_MODE=1 \
SETUP_CADDY=true \
BASE_URL=https://canvas.example.com \
ADMIN_EMAIL=me@example.com \
ADMIN_PASSWORD=yourpassword \
bash <(curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install.sh)
```

---

### Mac / Windows (local)

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/) and Node.js (v18+).

```bash
npm run setup
```

The script checks Docker, creates a config file from the template, builds the image, and opens the app at `http://localhost:3456`.

---

### Hosting platforms (EasyPanel, Coolify, Portainer, etc.)

Use `ghcr.io/canvascoding/canvas-notebook:latest` as the image. Mount `/data` as a persistent volume. Set the environment variables listed in the [Configuration](#configuration) section below.

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

Pull the latest image and restart — your data is untouched:

```bash
docker compose -f canvas-notebook-compose.yaml pull
docker compose -f canvas-notebook-compose.yaml up -d
```

For local / from-source installs:

```bash
git pull
npm run setup
```

---

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `BETTER_AUTH_SECRET` | **Yes** | Random 32-byte base64 secret — auto-generated by the installer |
| `CANVAS_INTERNAL_API_KEY` | **Yes** | Internal API secret — auto-generated by the installer |
| `BETTER_AUTH_BASE_URL` | **Yes** | Public URL of the app, e.g. `https://canvas.example.com` |
| `BOOTSTRAP_ADMIN_EMAIL` | **Yes** | Login email — created or updated on every start |
| `BOOTSTRAP_ADMIN_PASSWORD` | **Yes** | Login password |
| `BOOTSTRAP_ADMIN_NAME` | No | Display name for the admin (default: `Administrator`) |
| `ONBOARDING` | No | Provider setup wizard is enabled by default; set to `false` to skip it |
| `LOG_LEVEL` | No | `off` \| `error` \| `warn` \| `info` \| `debug` (default: `info`) |

AI provider API keys (Claude, OpenRouter, Gemini, etc.) are configured inside the running app — you don't need them here.

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

To build and run from source:

```bash
git clone https://github.com/canvascoding/canvas-notebook.git
cd canvas-notebook
npm run setup          # builds image and starts container

npm run dev            # local dev server (no Docker)
npm run lint
npm run test:all
```

Pre-built images are published automatically to `ghcr.io/canvascoding/canvas-notebook` when a new release tag is pushed.

---

## License

Sustainable Use License © [Frank Alexander Weber](https://github.com/canvascoding)
