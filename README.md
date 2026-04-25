# 📓 Canvas Notebook — Self-Hosted AI Workspace

<p align="center">
  <strong>A self-hosted, container-first workspace with an AI agent at its core.</strong>
</p>

<p align="center">
  <a href="https://github.com/canvascoding/canvas-notebook/releases"><img src="https://img.shields.io/github/v/release/canvascoding/canvas-notebook?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Sustainable_Use_1.0-orange?style=for-the-badge" alt="Sustainable Use License 1.0"></a>
  <img src="https://img.shields.io/badge/Next.js-black?style=for-the-badge&logo=next.js&logoColor=white" alt="Next.js">
  <a href="https://hub.docker.com/r/canvascoding/canvas-notebook"><img src="https://img.shields.io/badge/Docker-ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker"></a>
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

## Quickstart

**Requirements:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) and Node.js (v18+).

```bash
npm run setup
```

That's it. The script will:
1. Check that Docker is installed and running — if not, it tells you exactly where to download it
2. Create a config file (`.env.docker.local`) from the template if one doesn't exist yet, and ask you to fill in your credentials
3. Build the Docker image and start the container
4. Wait for the app to be ready and open a browser window at `http://localhost:3456`

If you don't change the config, the default login is `admin@example.com` / `admin`. You can change email and password at any time by editing the env file and restarting the container — the bootstrap script syncs the admin user on every startup.

After login, an optional onboarding wizard can guide you through AI provider setup.

> `npm install` is not required — the setup script only uses built-in Node.js modules.

---

## Data & Volumes

Everything is stored in `./data` on your host machine, mounted into the container at `/data`:

| Path | What lives here |
|------|----------------|
| `/data/workspace` | Your files |
| `/data/sqlite.db` | Database (sessions, users, chat history) |
| `/data/skills/` | Custom agent skills |
| `/data/secrets/` | Integration tokens and secrets |

Two named Docker volumes handle persistent tooling:
- `canvas_notebook_home` → `/home/node` — CLI tools installed at runtime (e.g. codex) survive container rebuilds
- `canvas_notebook_ollama` → `/ollama` — Ollama models don't need to be re-downloaded after updates

---

## Environment Variables

Copy `.env.docker.example` to `.env.docker.local` and set the values below. `npm run setup` does this automatically on first run.

| Variable | Required | Description |
|----------|----------|-------------|
| `BETTER_AUTH_SECRET` | **Yes** | Random 32-byte base64 secret — run `openssl rand -base64 32` |
| `CANVAS_INTERNAL_API_KEY` | **Yes** | Internal API secret — run `openssl rand -base64 32` |
| `BASE_URL` | **Yes** | App URL, e.g. `http://localhost:3456` |
| `BETTER_AUTH_BASE_URL` | **Yes** | Same as BASE_URL |
| `BOOTSTRAP_ADMIN_EMAIL` | Recommended | Single app login email, created or synchronized on every start |
| `BOOTSTRAP_ADMIN_PASSWORD` | Recommended | Password for the bootstrap admin |
| `BOOTSTRAP_ADMIN_NAME` | No | Display name for the bootstrap admin (default: Administrator) |
| `DATA` | No | Base path for all app data (default: `/data`) |
| `ONBOARDING` | No | Set to `true` to show the provider onboarding wizard after login |
| `AI_CLI_AUTO_INSTALL` | No | Auto-install AI CLI if missing (default: `false`) |
| `OLLAMA_CLI_AUTO_INSTALL` | No | Auto-install Ollama CLI if missing (default: `false`) |
| `LOG_LEVEL` | No | Logging level: `off` \| `error` \| `warn` \| `info` \| `debug` (default: `info`) |

AI provider API keys (Claude, OpenRouter, Gemini, etc.) are configured inside the running app — you don't need them in the env file.

---

## Skills

Skills extend what the AI agent can do. A skill is just a folder with a `SKILL.md` file:

```
/data/skills/
  my-skill/
    SKILL.md          # name, description, and instructions for the agent
    bin/my-skill      # optional: executable makes this skill a callable tool
```

The `SKILL.md` uses simple YAML frontmatter:
```yaml
---
name: my-skill
description: "What this skill does and when to use it"
---

Instructions for the agent...
```

Skills without an executable are loaded as context into the agent's system prompt. Skills with a `bin/` executable become callable tools the agent can invoke directly.

---

## Useful Commands

```bash
# Install / first-time setup / rebuild
npm run setup

# Watch logs
docker compose logs -f canvas-notebook

# Open a shell inside the container
docker exec -it canvas-notebook sh

# Stop
docker compose down

# Start again without rebuilding
docker compose up -d
```

---

## Pre-built Image

A pre-built image is available on Docker Hub — no local build required:

```
docker pull canvascoding/canvas-notebook:latest
```

### Option A: Docker Compose (recommended)

Download [`compose.hub.yaml`](https://github.com/canvascoding/canvas-notebook/blob/main/compose.hub.yaml), fill in your values, and run:

```bash
docker compose -f compose.hub.yaml up -d
```

All required environment variables are documented as comments inside the file. The only things you need to change are:
- `BETTER_AUTH_SECRET` — generate with `openssl rand -base64 32`
- `BASE_URL` / `BETTER_AUTH_BASE_URL` — the URL where the app will be reachable
- `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` — your login credentials (defaults: `admin@example.com` / `admin`)

You can update these at any time — just edit the values and restart the container. The bootstrap script syncs the admin user on every startup.

### Option B: Quick start with docker run

```bash
docker run -d \
  --name canvas-notebook \
  -p 3456:3000 \
  -v $(pwd)/data:/data \
  -v canvas_notebook_home:/home/node \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e BASE_URL="http://localhost:3456" \
  -e BETTER_AUTH_BASE_URL="http://localhost:3456" \
  -e BOOTSTRAP_ADMIN_EMAIL="admin@example.com" \
  -e BOOTSTRAP_ADMIN_PASSWORD="change-me" \
  -e ONBOARDING="true" \
  canvascoding/canvas-notebook:latest
```

Then open `http://localhost:3456`.

### Hosting platforms (EasyPanel, Coolify, etc.)

Use `canvascoding/canvas-notebook:latest` as the image source and set the environment variables above in the platform UI. Mount `/data` as a persistent volume.

---

## License

Sustainable Use License © [Frank Alexander Weber](https://github.com/canvascoding)
