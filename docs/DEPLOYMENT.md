# Deployment

## Custom Server
This app uses a custom Node server for WebSocket terminals (systemd-managed in production).
Automationen werden vom App-Prozess ueber einen internen Scheduler ausgefuehrt; es wird kein separates Linux-`cron` oder `crontab` im Container erwartet.

```bash
npm install
npm run build
npm run start
```

## systemd (Production)
```bash
sudo systemctl status canvas-notebook.service
sudo systemctl restart canvas-notebook.service
journalctl -u canvas-notebook.service -n 200 --no-pager
```

## Reverse Proxy (TLS)
Recommended: terminate TLS with Nginx and proxy to `localhost:3001`.

Example Nginx site:

```nginx
server {
  listen 443 ssl;
  server_name your-domain.example;

  ssl_certificate /etc/letsencrypt/live/your-domain.example/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

## Environment
Ensure these are set. Local dev uses `.env.local`, Docker/Compose should use `.env.docker.local`, and systemd uses `.env.systemd`:

- `BETTER_AUTH_SECRET` (>= 32 chars)
- `BETTER_AUTH_BASE_URL` (or fallback `BASE_URL`)
- `DATA` (recommended: `./data` - base path for workspace, sqlite.db, skills, etc.)
- `ALLOW_SIGNUP=false` (set `true` only for initial onboarding)

`DATA` should point to persistent storage. Workspace files, SQLite database, and skills are stored under this path (e.g., `/data/workspace`, `/data/sqlite.db`, `/data/skills`).

## Logging Configuration

Runtime logging can be configured via environment variables:

- `LOG_LEVEL` - Controls verbosity: `off` | `error` | `warn` | `info` | `debug` (default: `info` in production, `debug` in dev)
- `LOG_TO_STDOUT` - Write logs to stdout/stderr for Docker logging: `true` | `false` (default: `true` in dev, `false` in production)
- `LOG_FILE` - Custom log file path (default: `/data/logs/runtime.log` in production)

**Examples:**

```bash
# Production with verbose logs to stdout (for Docker)
LOG_LEVEL=debug
LOG_TO_STDOUT=true

# Production with minimal logging (only errors)
LOG_LEVEL=error
LOG_TO_STDOUT=false

# See logs in production
docker exec <container> tail -f /data/logs/runtime.log
# Or via systemd
journalctl -u canvas-notebook.service -f
```

Startup logs are always written to `/data/logs/startup.log`.

## Docker / EasyPanel
- Do not override the image `ENTRYPOINT` or startup command with `next-server`, `node server.js`, or a platform default.
- The image bootstrap path is responsible for creating or synchronizing the bootstrap admin before Next.js starts.
- If your platform requires an explicit command, use:

```bash
./scripts/docker-entrypoint.sh ./scripts/start-services.sh
```

- After deployment, container logs should include `[Startup] Running bootstrap-admin...` followed by either `Created admin user` or `Synced bootstrap admin user`.
