# 📓 Canvas Notebook

<p align="center">
  <strong>A self-hosted AI workspace that works with your files, tools, and recurring workflows.</strong>
</p>

<p align="center">
  <a href="https://github.com/canvascoding/canvas-notebook/releases"><img src="https://img.shields.io/github/v/release/canvascoding/canvas-notebook?include_prereleases&style=for-the-badge" alt="Latest release"></a>
  <a href="https://github.com/canvascoding/canvas-notebook/actions/workflows/build-both.yml"><img src="https://img.shields.io/github/actions/workflow/status/canvascoding/canvas-notebook/build-both.yml?branch=main&style=for-the-badge&label=build" alt="Build status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Sustainable_Use_1.0-orange?style=for-the-badge" alt="Sustainable Use License 1.0"></a>
  <a href="https://github.com/canvascoding/canvas-notebook/pkgs/container/canvas-notebook"><img src="https://img.shields.io/badge/container-GHCR-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Container image on GHCR"></a>
</p>

<p align="center">
  <a href="#-quick-start">Quick start</a> ·
  <a href="#-what-you-get">Features</a> ·
  <a href="#-configuration">Configuration</a> ·
  <a href="#-operations">Operations</a> ·
  <a href="#-security-and-data">Security</a>
</p>

---

Canvas Notebook combines a file workspace, editor, terminal, AI chat, automations, email, to-dos, and creative media tools in one container-first application. The agent can work directly with the files and tools you make available instead of living in an isolated chat window.

It is built for technical users, freelancers, creators, and small teams who want:

- 🏠 a workspace on infrastructure they control
- 🤖 a persistent agent that can read, write, search, and run tools
- 🔑 their own AI provider and API keys instead of a mandatory model subscription
- ⏱️ scheduled workflows that keep running when their laptop is closed
- 🧩 an extensible system based on skills, MCP servers, and integrations

> **Canvas Notebook is an AI workspace, not a replacement for an AI coding IDE.** It is strongest when the work spans files, research, content, email, assets, and recurring operational tasks.

## 🚀 Quick start

### Linux / VPS — recommended

Use a fresh Ubuntu or Debian server with `sudo` access. The installer can install Docker, configure the app, register the host-side management CLI and systemd service, and optionally set up Caddy for HTTPS.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install.sh)
```

The installer asks whether to use the pre-built image or build from source. For a normal deployment, choose the pre-built image.

After installation:

1. Open the configured domain, or `http://SERVER_IP:3456` without a reverse proxy.
2. Create the first admin account in the setup flow.
3. Optionally activate a free Community license now, or skip activation and continue in local Solo mode.
4. Add and verify an AI provider.
5. Check the deployment with `canvas-notebook status` and `canvas-notebook health`.

License activation is optional and remains available later in **Settings → License**. An unlicensed Notebook keeps its local core features and can run in a private network without internet access. Community activation sends the instance ID and the email address you enter to `api.canvasnotebook.app` so a signed license certificate can be issued. Workspace files, prompts, API keys, and other local data are not part of the activation request.

If you enable Caddy, point your domain's DNS record to the server and allow inbound traffic on ports `80` and `443`. Without Caddy, the application listens on host port `3456` by default.

### Docker Compose — pre-built image and Postgres

Requirements: Docker Engine with Compose v2 and OpenSSL for secret generation.

```bash
git clone https://github.com/canvascoding/canvas-notebook.git
cd canvas-notebook
cp .env.docker.example .env.docker.local

openssl rand -base64 32
openssl rand -base64 32
```

Open `.env.docker.local`, replace both `SET_WITH_OPENSSL_RAND_BASE64_32` placeholders with the generated values, and replace the Postgres `change-me` password in both occurrences. Then start the stack:

```bash
docker compose -f compose.ghcr.yaml up -d
curl -fsS http://localhost:3456/api/health
```

Open [http://localhost:3456](http://localhost:3456) and complete the setup flow. The included Compose file stores application data in `./data` and database data in a managed Postgres 18 volume.

To use a different host port:

```bash
HOST_PORT=8080 docker compose -f compose.ghcr.yaml up -d
```

Update `BASE_URL` and `BETTER_AUTH_BASE_URL` in `.env.docker.local` to match the URL your browser uses.

### macOS / Windows — local Docker server

These installers set up the portable `canvas-notebook` CLI, ensure Docker Desktop is available, start the server on `http://localhost:3456`, and register a user-level startup service.

**macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/macos.sh | bash
```

**Windows PowerShell**

```powershell
irm https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/windows.ps1 | iex
```

Set `CANVAS_INSTALL_SERVICE=false` to skip startup service registration or `CANVAS_OPEN_BROWSER=false` to prevent the installer from opening the browser. Set `CANVAS_VERSION` to a release tag if you want to pin the installed CLI version.

### Coolify and other container platforms

For Coolify, deploy [`compose.coolify.yaml`](compose.coolify.yaml). It runs Canvas Notebook with PostgreSQL/pgvector and uses Coolify's generated service URL, users, and secrets.

For other container platforms, start from [`compose.ghcr.yaml`](compose.ghcr.yaml) and provide:

- a persistent volume mounted at `/data`
- port `3000` inside the container
- the required variables listed under [Configuration](#-configuration)
- a health check against `GET /api/health`

## ✨ What you get

| | Capability | What it is useful for |
|---|---|---|
| 🤖 | **Workspace agent** | Persistent conversations, direct file operations, shell tools, research, and specialized agents with their own instructions and models |
| 📝 | **Notebook and files** | Markdown and code editing, uploads, previews, search, downloads, public links, and common document/media formats |
| ⏱️ | **Automations** | Scheduled or webhook-triggered agent jobs for reports, content pipelines, monitoring, and follow-up work |
| 🎨 | **Studio** | Generate and organize images, video, and sound with reusable products, personas, styles, and presets |
| 📬 | **Email and to-dos** | Review mail, draft replies, apply send policies, and hand agent results back to humans as actionable tasks |
| 🧩 | **Skills and integrations** | Add reusable `SKILL.md` workflows, executable tools, MCP servers, and Composio-connected applications |
| 🗂️ | **Workspaces and collaboration** | Keep projects separate, share supported files, and collaborate live where team features are enabled |
| 📊 | **Usage analytics** | Inspect model, token, and cost usage across users and sessions |

The browser UI is available in English and German.

### AI providers

Bring your own credentials and choose the provider/model at runtime. The built-in catalog includes:

- OpenRouter
- Anthropic
- Google Gemini
- OpenAI
- Ollama and OpenAI-compatible endpoints
- Groq, Mistral, and additional supported providers

Provider credentials are configured after installation in the application settings; they are not required to boot the container. Model and media API usage is billed separately by the provider you choose.

### Skills

A skill is a folder with a `SKILL.md` file. Add an executable under `bin/` when the agent should be able to call it as a tool.

```text
/data/skills/
└── my-skill/
    ├── SKILL.md
    └── bin/
        └── my-skill
```

Minimal `SKILL.md`:

```yaml
---
name: my-skill
description: What this skill does and when the agent should use it
---

Instructions for the agent...
```

Skills and their required environment variables can be managed from **Settings**. Keep integration secrets in the provided settings UI instead of hardcoding them in a skill.

## ⚙️ Configuration

For manual container deployments, these variables are the minimum:

| Variable | Required | Purpose |
|---|---:|---|
| `BASE_URL` | Yes | Browser-facing URL, for example `https://canvas.example.com` |
| `BETTER_AUTH_BASE_URL` | Yes | Authentication base URL; normally identical to `BASE_URL` |
| `BETTER_AUTH_SECRET` | Yes | Random secret used to sign authentication data |
| `CANVAS_INTERNAL_API_KEY` | Yes | Random secret for trusted internal API calls |
| `BETTER_AUTH_TRUSTED_ORIGINS` | No | Additional comma-separated browser origins allowed for auth and chat WebSockets |
| `CANVAS_DATABASE_PROVIDER` | Yes | Must be `postgres` for new production installations |
| `CANVAS_POSTGRES_MODE` | Yes | `managed` for the included database or `external` through the portable CLI |
| `DATABASE_URL` | Yes | PostgreSQL connection URL |

Generate secrets with:

```bash
openssl rand -base64 32
```

The pre-built image defaults to container port `3000` and `DATA=/data`; new production installations use Postgres. See [`.env.docker.example`](.env.docker.example) for managed-Postgres, logging, browser-export, and admin-bootstrap settings.

## 🛠️ Operations

The installers provide a host-side `canvas-notebook` command. Run it on the host, not inside the application container.

| Command | Purpose |
|---|---|
| `canvas-notebook status` | Show container and Compose status |
| `canvas-notebook health` | Check the local health endpoint |
| `canvas-notebook diagnose` | Inspect host, Docker, memory, OOM, and container state |
| `canvas-notebook logs` | Follow application logs |
| `canvas-notebook update` | Pull and apply the latest image with health checks and rollback protection |
| `canvas-notebook restart` | Restart the application and wait until it is healthy |
| `canvas-notebook backup create --output ./backup.zip` | Create a full backup and copy it to the host |
| `canvas-notebook admin reset-password --email admin@example.com --password-stdin` | Create or reset admin access without storing the password in environment files |
| `canvas-notebook auto-update-status` | Show automatic update timer state |

Run `canvas-notebook help` for the full command reference.

### Updating a manual Compose installation

```bash
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d --force-recreate
curl -fsS http://localhost:3456/api/health
```

The `/data` mount is not replaced when the container is recreated.

## 🔐 Security and data

All persistent application state lives under `/data` in the container. With `compose.ghcr.yaml`, this is the repository's local `./data` directory; the Linux installer uses its configured host data directory.

| Container path | Contents |
|---|---|
| `/data/workspaces/` | Current user, organization, team, and project workspace files |
| `/data/workspace/` | Legacy personal-workspace alias used by older installations |
| `/data/sqlite.db` | Legacy SQLite database retained for existing installations and migration |
| `/data/skills/` and `/data/plugins/` | Installed agent extensions |
| `/data/secrets/` | Credentials managed through the application settings |
| `/data/system/backups/` | Locally generated backup artifacts |

Before exposing an instance to the internet:

- 🔒 terminate TLS with Caddy or another reverse proxy
- 🎲 use unique random values for both required secrets
- 💾 back up the host data volume and test your restore process
- 🚫 keep `.env.docker.local`, `/data/secrets`, and backups out of version control
- 🧱 restrict host and container access—the agent can execute tools and modify files within its granted scope
- 👀 review public links and third-party integrations regularly

Self-hosting keeps the workspace and database on your infrastructure. License activation exchanges the instance ID and account email with the Canvas license service. When you use an external AI or integration provider, the context required for that request is sent to that provider according to its terms and your configuration.

For vulnerability reports and supported versions, see [`SECURITY.md`](SECURITY.md).

## 🧑‍💻 Development

Production users should prefer the published container image. To work on Canvas Notebook itself:

```bash
git clone https://github.com/canvascoding/canvas-notebook.git
cd canvas-notebook
npm ci
npm run dev
```

Useful checks:

```bash
npm run lint
npm run build
npm run test:all
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before submitting changes and [`CHANGELOG.md`](CHANGELOG.md) for release history.

## 📄 License

Canvas Notebook is distributed under the [Sustainable Use License 1.0](LICENSE). Personal, non-commercial, and internal business use is permitted under its terms. Offering Canvas Notebook or a derivative as a competing hosted or managed service is not permitted. Read the license before deploying it for a commercial service.

Self-hosted instances do not require activation for local Solo use. A free Community certificate can be activated voluntarily during setup or later in the license settings. Team collaboration and additional active users require a valid Team Seat entitlement; commercial seat changes also require a claimed Community license and a Control Plane connection. See the [licensing and Team Seats owner guide](docs/team-seat-licensing-owner-guide.md) for offline behavior, costs, grace periods, downgrade recovery, and supported versions.

Copyright © [Frank Alexander Weber](https://github.com/canvascoding)
