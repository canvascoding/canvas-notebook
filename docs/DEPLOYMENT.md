# Deployment

## Custom Server
This app uses a custom Node server for WebSocket terminals (systemd-managed in production).

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
- `WORKSPACE_DIR` (recommended: `./data/workspace`)
- `SQLITE_PATH` (recommended: `./data/sqlite.db`)
- `ALLOW_SIGNUP=false` (set `true` only for initial onboarding)
- `MAX_TERMINALS_PER_USER` and `TERMINAL_IDLE_TIMEOUT`
