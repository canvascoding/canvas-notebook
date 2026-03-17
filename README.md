# Canvas Notebook

**A self-hosted, container-first workspace with an AI agent at its core.**

Built by [canvascoding](https://github.com/canvascoding) — runs entirely in Docker, no setup beyond a single config file.

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

After login, an optional onboarding wizard can guide you through AI provider setup. The app user itself is always defined via the bootstrap env vars.

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
| `BETTER_AUTH_SECRET` | Yes | Random 32-byte base64 secret — run `openssl rand -base64 32` |
| `BASE_URL` | Yes | App URL, e.g. `http://localhost:3456` |
| `BETTER_AUTH_BASE_URL` | Yes | Same as BASE_URL |
| `BOOTSTRAP_ADMIN_EMAIL` | Recommended | Single app login email, created or synchronized on every start |
| `BOOTSTRAP_ADMIN_PASSWORD` | Recommended | Password for the bootstrap admin |
| `BOOTSTRAP_ADMIN_NAME` | No | Display name for the bootstrap admin (default: Administrator) |
| `ONBOARDING` | No | Set to `true` to show the provider onboarding wizard after login |
| `AI_CLI_AUTO_INSTALL` | No | Auto-install Codex CLI if missing (default: `true`) |
| `OLLAMA_CLI_AUTO_INSTALL` | No | Auto-install Ollama CLI if missing (default: `true`) |

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

If you don't want to build locally, a pre-built image is available on GHCR and updated on every push to `main`:

```
ghcr.io/canvascoding/canvas-notebook:latest
```

Works with EasyPanel, Coolify, or any other Docker-based hosting platform. Use `Docker image` as the source and mount `/data` as a persistent volume.

---

## License

Private project — Canvas Notebook. All rights reserved.
