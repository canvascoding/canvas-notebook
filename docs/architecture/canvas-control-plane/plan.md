# Canvas Control Plane – V1 Architecture Plan

**Status:** Draft  
**Date:** May 2026  
**Scope:** Self-hosted VM management for Canvas Notebook (V1: Admin-only)

---

## 1. Vision

A unified platform to manage multiple Canvas Notebook VMs from a single dashboard.

- **Serverless UI:** Next.js app (Netlify/Vercel) with Better Auth for admin login.
- **Control Plane API:** A small, dedicated VM (e.g. Hetzner CX21 / IONOS Basic XS) running Fastify + Postgres. Acts as the central relay.
- **Client VM:** Any Linux VM running Docker + Canvas Notebook. A lightweight Node.js agent connects back to the Control Plane via a persistent WebSocket tunnel.

This architecture works regardless of whether VMs are in the same private LAN or scattered across different providers and home networks.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ 1. SERVERLESS UI (Next.js on Netlify/Vercel)              │
│    • Better Auth (Admin login)                              │
│    • Dashboard: VM list, live metrics, terminal, logs       │
│    • No persistent state, no WebSocket server               │
└──────────────────┬──────────────────────────────────────────┘
                   │ Browser loads HTML/JS from CDN
                   │
                   ▼ HTTPS / WSS (direct from browser)
┌─────────────────────────────────────────────────────────────┐
│ 2. CONTROL PLANE API (Dedicated VM, e.g. Hetzner)           │
│    • Caddy (Reverse Proxy, TLS termination)                  │
│    • Fastify (HTTP API + WebSocket server)                 │
│    • Postgres (State, audit log, VM registry)                │
│    • In-Memory state for active connections (V1)           │
└──────────────┬────────────────────────────────────────────┘
               │ Persistent WSS Tunnel (outbound from VM)
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. CLIENT VM (Customer / Developer Server)                │
│    • Docker + Canvas Notebook container (Port 3000)       │
│    • Canvas CLI (`canvas-notebook` for local updates)      │
│    • Canvas Agent (Node.js systemd service)                 │
│      – WS client to Control Plane                           │
│      – Collects host + docker metrics                       │
│      – Executes commands via Docker CLI                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Network & Communication

### 3.1 Ports & Protocols

| Service | Protocol | Port | Source | Target |
|---------|----------|------|--------|--------|
| Admin Dashboard | HTTPS | 443 | Browser | `api.yourdomain.com` |
| Admin Live Stream | WSS | 443 | Browser | `api.yourdomain.com/ws` |
| Agent Tunnel | WSS | 443 | Client VM | `api.yourdomain.com/agent` |

All traffic is encrypted via TLS 1.3 (handled by Caddy).

### 3.2 HTTPS vs. WebSocket

**HTTPS (REST API):**
- `GET /v1/vms` – List all registered VMs.
- `GET /v1/vms/:id` – VM details (last known state).
- `POST /v1/vms/:id/exec` – Queue a command. Returns `cmdId` immediately.
- `GET /v1/vms/:id/logs?cursor=...` – Fetch paginated historical logs.
- `GET /v1/vms/:id/metrics/history?from=...&to=...` – Time-series metrics (from DB).
- `POST /auth/exchange` – Exchange Better Auth session for a short-lived API token.

**WebSocket (Real-time):**
- `wss://api.yourdomain.com/ws?token=<jwt>` – Admin browser connection.
- `wss://api.yourdomain.com/agent?key=<apiKey>` – Client VM agent connection.

**Why two WebSocket channels?**
- The **agent tunnel** is a persistent, server-to-server (machine-to-machine) backplane. It is always on.
- The **browser stream** is ephemeral. It only exists while the admin tab is open. It connects to the same API VM, which relays data from the agent tunnel.

### 3.3 Why the Agent Connects Outbound

Client VMs often sit behind NAT, dynamic IPs, or firewalls. By having the agent initiate an outbound WSS connection to the central API, no inbound ports need to be opened on the client VM. The Control Plane only needs a stable public IP + domain.

---

## 4. Authentication & Authorization

### 4.1 Three Layers

| Layer | Actor | Mechanism | Managed By |
|-------|-------|-----------|------------|
| **UI Login** | Human Admin | Better Auth (session cookie) | Serverless UI |
| **UI → API** | Browser | Short-lived JWT (1 hour) | Control Plane API |
| **Agent → API** | VM Agent | Long-lived API Key (`sk_live_...`) | Control Plane API |

### 4.2 Token Exchange Flow

```
1. Admin logs in via Better Auth on Netlify UI
        ↓
2. UI calls POST /auth/exchange (Serverless Function)
   – Verifies Better Auth session
   – Generates JWT: { userId, role: 'admin', exp: '1h' }
   – Signs with SHARED_SECRET (256-bit, ENV only)
        ↓
3. Browser stores JWT in app memory (NOT localStorage/sessionStorage)
        ↓
4. Browser sends JWT on every request:
   – HTTP Header: `Authorization: Bearer <jwt>`
   – WS Query: `?token=<jwt>`
        ↓
5. API VM verifies JWT signature + expiry + role
```

### 4.3 Agent Authentication

- When an admin registers a new VM in the UI, the API generates a unique `api_key` (plain text shown once to admin).
- The key is stored in the DB as a bcrypt hash.
- The admin copies the key into the agent installation script on the VM.
- The agent sends the key as a query parameter during the WSS handshake.
- The API verifies it against the hash and identifies the VM.

### 4.4 Revocation

- Agent keys can be revoked via the UI. The API invalidates the connection and rejects future handshakes.
- Admin JWTs cannot be revoked individually (V1), but they expire in 1 hour. The admin must re-login via Better Auth to get a new one.

---

## 5. Tech Stack

### 5.1 Serverless UI

| Component | Technology |
|-----------|------------|
| Framework | Next.js 14 (App Router) |
| Auth | Better Auth (email/password) |
| Hosting | Netlify or Vercel |
| Styling | Tailwind + shadcn/ui |
| State | React Query (server state) + Zustand (UI state) |

**Key architectural rule:** The UI is stateless. It never holds WebSocket connections server-side (Netlify Functions). The user's browser opens the WebSocket directly to the Control Plane API.

### 5.2 Control Plane API

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20 LTS |
| Framework | Fastify (v4+) |
| WebSocket | `@fastify/websocket` |
| Database | Postgres 15 |
| ORM | Drizzle ORM |
| Validation | Zod |
| Rate Limiting | `rate-limiter-flexible` (in-memory for V1) |
| Reverse Proxy | Caddy (automatic TLS) |
| Process Manager | PM2 |

**Why Fastify instead of Next.js for the API?**
- Native, stable WebSocket support.
- Background tasks (heartbeats, timeouts) live outside the request/response cycle.
- No framework overhead for a pure API server.
- Easier horizontal scaling later (just run more Fastify processes).

### 5.3 Canvas Agent

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20 LTS |
| WS Client | `ws` |
| Process Manager | systemd |
| Metrics | `os`, `fs`, `child_process` (docker stats) |

---

## 6. Database Schema (Postgres)

### 6.1 Tables

```sql
-- Registered VMs / Agents
CREATE TABLE vm_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    -- Auth
    api_key_hash TEXT NOT NULL,
    api_key_prefix TEXT NOT NULL, -- e.g. 'sk_live_ab...' for UI display
    -- Network
    public_ip TEXT,
    private_ip TEXT,
    -- State (updated by heartbeat)
    status TEXT NOT NULL DEFAULT 'pending', -- pending, online, offline, error
    docker_status TEXT,
    canvas_version TEXT,
    last_seen_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Commands (Audit Log + Queue)
CREATE TABLE vm_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES vm_agents(id) ON DELETE CASCADE,
    command TEXT NOT NULL,          -- e.g. 'canvas-notebook restart'
    payload JSONB,                  -- extra args if needed
    status TEXT NOT NULL DEFAULT 'queued', -- queued, running, done, failed, cancelled
    exit_code INT,
    output TEXT,                    -- full output (truncated if too large)
    error TEXT,
    queued_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

-- Metrics (Time-series, sampled every 30s by agent)
CREATE TABLE vm_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES vm_agents(id) ON DELETE CASCADE,
    sampled_at TIMESTAMP DEFAULT NOW(),
    cpu_percent FLOAT,
    memory_percent FLOAT,
    memory_used_mb INT,
    memory_total_mb INT,
    disk_percent FLOAT,
    disk_used_gb FLOAT,
    disk_total_gb FLOAT,
    docker_cpu_percent FLOAT,       -- from 'docker stats'
    docker_memory_usage_mb INT
);

-- Alerts (OOM, Disk Full, etc.)
CREATE TABLE vm_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES vm_agents(id) ON DELETE CASCADE,
    type TEXT NOT NULL,             -- oom, disk_full, restart_loop, etc.
    severity TEXT NOT NULL,         -- warning, critical
    message TEXT NOT NULL,
    metadata JSONB,                 -- e.g. { process: 'node', exitCode: 137 }
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### 6.2 Indexes

- `vm_agents(status, last_seen_at)` – For dashboard queries.
- `vm_commands(agent_id, queued_at DESC)` – For command history.
- `vm_metrics(agent_id, sampled_at DESC)` – For charts.
- `vm_alerts(agent_id, created_at DESC, resolved_at)` – For alert panels.

---

## 7. Canvas Agent Specification

### 7.1 Deployment

The agent runs as a **systemd service** directly on the VM host (outside Docker). This allows it to control the Docker daemon and read host-level metrics.

```ini
# /etc/systemd/system/canvas-agent.service
[Unit]
Description=Canvas Control Plane Agent
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=5
EnvironmentFile=/etc/canvas-agent/agent.env
ExecStart=/usr/bin/node /opt/canvas-agent/agent.js

[Install]
WantedBy=multi-user.target
```

### 7.2 Installation Flow

1. Admin creates a VM entry in the UI (`POST /v1/vms`).
2. API generates an `api_key` (plain text shown once). Stores hash in DB.
3. Admin SSHs (or copy-pastes) into the VM and runs:
   ```bash
   curl -fsSL https://api.yourdomain.com/install-agent.sh | \
     API_KEY=sk_live_xxx \
     PANEL_URL=wss://api.yourdomain.com/agent \
     bash
   ```
4. Script writes `/etc/canvas-agent/agent.env`, installs systemd service, starts agent.
5. Agent connects to Control Plane. Status changes from `pending` to `online`.

### 7.3 Agent Protocol (WSS)

**Connection:**
```
wss://api.yourdomain.com/agent?key=sk_live_xxx
```

**Messages:**

```typescript
// Agent → API (Heartbeat, every 30s)
{
  "type": "heartbeat",
  "timestamp": "2026-05-06T10:00:00Z",
  "status": "online",
  "dockerStatus": "running", // running, stopped, restarting, dead
  "canvasVersion": "1.4.2",
  "uptimeSeconds": 3600
}

// Agent → API (Metrics payload, every 30s)
{
  "type": "metrics",
  "timestamp": "2026-05-06T10:00:00Z",
  "host": {
    "cpuPercent": 12.5,
    "memoryPercent": 45.2,
    "memoryUsedMb": 920,
    "memoryTotalMb": 2048,
    "diskPercent": 67.0,
    "diskUsedGb": 40.2,
    "diskTotalGb": 60.0
  },
  "docker": {
    "cpuPercent": 8.3,
    "memoryUsageMb": 512
  }
}

// Agent → API (Alert)
{
  "type": "alert",
  "alertType": "oom",
  "severity": "critical",
  "message": "OOM Killer terminated Node.js process in Canvas container",
  "metadata": { "process": "node", "container": "canvas-notebook" }
}

// API → Agent (Execute command)
{
  "type": "exec",
  "cmdId": "cmd_uuid_123",
  "command": "canvas-notebook update",
  "timeout": 300
}

// Agent → API (Command output stream)
{
  "type": "output",
  "cmdId": "cmd_uuid_123",
  "chunk": "Pulling image...\n",
  "done": false
}

// Agent → API (Command finished)
{
  "type": "output",
  "cmdId": "cmd_uuid_123",
  "chunk": "",
  "done": true,
  "exitCode": 0
}
```

### 7.4 OOM Detection (A)

On each heartbeat, the agent:
1. Checks if the Canvas container is running (`docker ps`).
2. If container state changed to `exited` or `restarting`, reads recent kernel logs:
   ```bash
   dmesg -T | grep -i 'killed process' | tail -n 5
   ```
   (Or parses `/var/log/kern.log` if available).
3. If an OOM is detected for the Node.js/Docker process, sends an `alert` message immediately.
4. Control Plane writes to `vm_alerts` and pushes a real-time notification to all connected admin browsers.

---

## 8. Control Plane API Specification

### 8.1 Fastify Structure

```
src/
├── server.ts              # Fastify instance, CORS, JWT hook
├── plugins/
│   ├── websocket.ts       # Registers @fastify/websocket
│   └── rateLimit.ts       # In-memory rate limiter
├── routes/
│   ├── auth.ts            # POST /auth/exchange
│   ├── vms.ts             # CRUD for VMs
│   ├── commands.ts        # POST /vms/:id/exec
│   ├── metrics.ts         # GET /vms/:id/metrics
│   └── health.ts          # GET /health
├── sockets/
│   ├── agentHandler.ts    # Handles WSS for agents
│   └── adminHandler.ts    # Handles WSS for browsers
├── services/
│   ├── commandQueue.ts    # In-memory queue + dispatcher
│   └── stateManager.ts    # Maps: agentId -> ws connection
├── db/
│   └── schema.ts          # Drizzle schema
└── lib/
    └── jwt.ts             # Verify / sign tokens
```

### 8.2 REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/exchange` | Better Auth Session (via Netlify proxy) | Returns JWT for browser |
| `GET` | `/v1/vms` | JWT | List all VMs (latest state from memory/DB) |
| `GET` | `/v1/vms/:id` | JWT | VM details + last 10 commands |
| `POST` | `/v1/vms` | JWT | Register new VM (returns API key once) |
| `DELETE`| `/v1/vms/:id` | JWT | Deregister VM (revokes key, closes connection) |
| `POST` | `/v1/vms/:id/exec` | JWT | Queue command. Returns `{ cmdId }` |
| `GET` | `/v1/vms/:id/commands` | JWT | Command history (paginated) |
| `GET` | `/v1/vms/:id/metrics` | JWT | Latest metrics snapshot |
| `GET` | `/v1/vms/:id/metrics/history` | JWT | Time-series metrics |
| `GET` | `/v1/vms/:id/alerts` | JWT | Active + resolved alerts |
| `POST` | `/v1/vms/:id/revoke-key` | JWT | Rotates agent API key |

### 8.3 Asynchronous Command Execution (B)

When an admin clicks "Restart" in the UI:

```
1. Browser: POST /v1/vms/:id/exec
   Body: { command: "canvas-notebook restart" }
        ↓
2. API: Validates JWT, creates DB row in vm_commands (status='queued')
   Returns: { cmdId: "cmd_uuid_123" }
        ↓
3. Browser: Immediately shows "Queued..."
        ↓
4. API (commandQueue service):
   – If agent is online, sends exec message over agent WSS.
   – Updates DB: status='running', started_at=NOW()
        ↓
5. Agent: Executes command locally, streams output back via WSS.
        ↓
6. API: Forwards output chunks to all connected admin browser sockets
   (in-memory mapping: vmId -> [adminWs1, adminWs2, ...])
        ↓
7. Agent: Sends final output with done=true, exitCode.
        ↓
8. API: Updates DB: status='done', exit_code, completed_at.
   Notifies browsers via WS: { type: 'cmd:done', cmdId, exitCode }
```

If the agent is offline, the command stays `queued` until the agent reconnects (or until a timeout, e.g. 24h, after which it is marked `failed`).

### 8.4 WebSocket Admin Stream

Browser connects to `wss://api.yourdomain.com/ws?token=<jwt>`.

**Messages API → Browser:**

```typescript
// Real-time VM status change
{ "type": "vm:status", "vmId": "uuid", "status": "online", "timestamp": "..." }

// Live metrics push (every 30s, same as agent heartbeat)
{ "type": "vm:metrics", "vmId": "uuid", "metrics": { ... } }

// Alert notification
{ "type": "vm:alert", "vmId": "uuid", "alert": { type: "oom", ... } }

// Command output (streamed from agent)
{ "type": "cmd:output", "vmId": "uuid", "cmdId": "...", "chunk": "...", "done": false }

// Command finished
{ "type": "cmd:done", "vmId": "uuid", "cmdId": "...", "exitCode": 0 }
```

**Messages Browser → API:**

```typescript
// Subscribe to a specific VM (admin opens detail page)
{ "type": "subscribe", "vmId": "uuid" }

// Unsubscribe
{ "type": "unsubscribe", "vmId": "uuid" }
```

### 8.5 In-Memory State (V1)

No Redis in V1. The Fastify instance maintains three maps:

```typescript
// agentId -> WebSocket connection
const agentSockets = new Map<string, WebSocket>();

// adminUserId -> Set of WebSocket connections
const adminSockets = new Map<string, Set<WebSocket>>();

// vmId -> Set of subscribed admin sockets
const subscriptions = new Map<string, Set<WebSocket>>();
```

**Limitation:** This only works on a single API VM instance. If you scale horizontally later, you must introduce Redis (Pub/Sub for cross-instance message relay).

---

## 9. UI / Dashboard Specification

### 9.1 Pages

| Route | Purpose |
|-------|---------|
| `/login` | Better Auth login (admin only in V1) |
| `/dashboard` | Overview: all VMs, status grid, quick actions |
| `/dashboard/vms/[id]` | VM detail: live metrics charts, terminal, logs, command history, alerts |
| `/dashboard/vms/new` | Register new VM (shows API key + install script) |

### 9.2 Live Metrics Display

- **CPU / RAM / Disk:** Gauges / Line charts using the last `metrics` message.
- **Docker Stats:** Separate section showing container-specific usage.
- **Update interval:** Every 30s (when agent sends heartbeat). No need for faster polling.
- **Chart library:** Any lightweight library (e.g. Tremor, Recharts) or plain SVG.

### 9.3 Terminal & Logs

- **Live Logs:** A scrollable terminal-like panel. Subscribes to the VM via WS. Receives `cmd:output` chunks and `vm:alert` messages.
- **Run Command:** Dropdown with common commands ("Restart", "Update", "Pull Logs") + custom input. Sends `POST /v1/vms/:id/exec`. Output streams into the terminal panel.

### 9.4 Alert Panel

- Lists active alerts (`vm_alerts` where `resolved_at IS NULL`).
- Color-coded by severity.
- OOM alerts include a direct link to the VM detail page.

---

## 10. Security & Hardening

### 10.1 Network

| Layer | Measure |
|-------|---------|
| **TLS** | Caddy enforces TLS 1.3, auto-renews Let's Encrypt certs. |
| **CORS** | API only allows origin from your Netlify deployment URL. |
| **Caddy headers** | `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`. |

### 10.2 Rate Limiting

| Target | Limit | Window |
|--------|-------|--------|
| `POST /auth/exchange` | 5 attempts | 15 minutes per IP |
| `POST /v1/vms/:id/exec` | 10 commands | 1 minute per admin user |
| Agent heartbeats | Max 1 per 10 seconds | Per agent (drop excess) |
| Browser WS connections | Max 5 | Concurrent per IP |
| General API | 100 requests | 1 minute per IP |

Implemented via `rate-limiter-flexible` in memory.

### 10.3 Agent Key Handling

- Keys are generated with high entropy (`crypto.randomBytes(32)`).
- Prefix (e.g. `sk_live_`) is stored in plain text for UI display; the rest is bcrypt-hashed.
- Key is shown **only once** during VM creation. If lost, admin must revoke and regenerate.

### 10.4 Audit Logging

Every command executed on a VM is stored in `vm_commands` with:
- Who triggered it (admin user ID).
- Exact command string.
- Output, exit code, timestamps.

### 10.5 Environment Variables (Secrets)

These are stored in `/data/secrets/Canvas-Integrations.env` on the API VM (as per project rules):

```env
DATABASE_URL=postgres://...
SHARED_SECRET=<256-bit-jwt-signing-key>
CADDY_DOMAIN=api.yourdomain.com
```

Never commit them. Never expose them to the browser.

---

## 11. Deployment (V1)

### 11.1 API VM Setup (Example: Hetzner CX21)

1. Provision Ubuntu 22.04 VM.
2. Install Node.js 20, Postgres 15, Caddy.
3. Clone repo, run `npm ci`, build Fastify app.
4. Run DB migrations (Drizzle).
5. Start with PM2: `pm2 start dist/server.js --name canvas-api`.
6. Caddy config (`Caddyfile`):
   ```
   api.yourdomain.com {
     reverse_proxy localhost:3001
   }
   ```

### 11.2 Serverless UI

1. `npm run build` in Next.js app.
2. Deploy to Netlify / Vercel.
3. Set environment variables:
   ```
   NEXT_PUBLIC_API_URL=https://api.yourdomain.com
   BETTER_AUTH_SECRET=...
   ```

### 11.3 Agent Installation on Client VM

See section 7.2. The script installs the Node.js agent as a systemd service.

---

## 12. Roadmap: From V1 to SaaS

| Phase | Feature | Tech Change |
|-------|---------|-------------|
| **V1 (Now)** | Admin-only, single API VM, in-memory state | Fastify + Postgres |
| **V2** | Stripe billing, multi-tenant (customers) | Row-level security in DB, subdomains |
| **V3** | Auto-provisioning via IONOS API | IONOS Cloud API client, cloud-init integration |
| **V4** | Horizontal scaling | Redis (Pub/Sub + rate limiting), load balancer |
| **V5** | Advanced networking | Optional WireGuard overlay for direct VM access |

---

## 13. Open Questions / Future Considerations

- **IONOS Integration:** Provisioning/stopping cubes via IONOS Cloud API is out of scope for V1. The first VMs are added manually via the agent.
- **Redis Migration:** When moving to multiple API instances, replace in-memory maps with Redis Streams or Pub/Sub.
- **File Uploads:** If admins need to push files to VMs, use `tar` over the agent tunnel or implement SFTP proxying later.
- **Logs Retention:** `vm_commands.output` and `vm_metrics` should have a cleanup job (e.g. delete metrics older than 90 days).
- **Backups:** Control Plane DB should be backed up daily (e.g. `pg_dump` to S3).

---

*Document maintained by: Canvas Studios Team*  
*Next step: Implementation of Fastify API scaffolding and Agent prototype.*