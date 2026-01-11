# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Running the Application

```bash
# Development server (disables Turbopack due to native modules)
PORT=3001 npm run dev

# Production build (uses webpack, not Turbopack)
npm run build

# Production server (uses standalone mode with custom server)
npm run start
```

### Testing

```bash
# Smoke test (requires running server)
npm run test:smoke

# Integration tests (API tests)
npm run test:integration

# E2E tests (Playwright)
npm run test:e2e

# All tests (build + start + smoke + integration + e2e)
npm run test:all
```

### Deployment

```bash
# Check systemd service status
systemctl status canvas-notebook.service

# View logs
journalctl -u canvas-notebook.service -n 200 --no-pager

# Restart service
sudo systemctl restart canvas-notebook.service

# Deploy new version
npm run build
sudo systemctl restart canvas-notebook.service
```

## High-Level Architecture

### Dual-Server Architecture

This application uses a **custom Node.js server** (`server.js`) that wraps Next.js to support WebSocket connections for the terminal feature:

- **Next.js Server**: Handles HTTP routes, API endpoints, SSR/SSG
- **Custom Server**: Intercepts WebSocket upgrade requests for `/api/terminal/*`

The custom server is required because Next.js API routes don't support WebSocket upgrades.

### Terminal System Architecture

The terminal uses a **remote SSH shell** approach, not local PTY processes:

1. **Client** (`XTerminal.tsx`): xterm.js terminal UI with WebSocket connection
2. **WebSocket Layer** (`terminal-server.js`): Validates session, handles upgrades
3. **Session Manager** (`terminal-manager.js`): Creates/manages SSH shell sessions
4. **SSH Connection**: Connects to remote server via `ssh2` library, creates PTY shell
5. **Bidirectional Communication**:
   - Client input → WebSocket → SSH stream (stdin)
   - SSH stream (stdout/stderr) → WebSocket → Terminal UI

**Key Implementation Details:**
- Uses `ssh2` native SSH shells (not `node-pty` local processes)
- Connection pooling is **separate** for file operations (SFTP) vs terminal (shell)
- Multiple browser tabs can connect to the same terminal session (broadcast model)
- Idle timeout: 30 minutes (configurable)
- Max terminals per user: 3 (configurable)

### File Operations Architecture

File operations use a **separate SSH/SFTP connection pool**:

1. **Client** (`file-store.ts`): Zustand state management
2. **API Routes** (`/app/api/files/*`): File CRUD operations
3. **SFTP Client** (`sftp-client.ts`): Abstraction over `ssh2-sftp-client`
4. **Connection Pool** (`connection-pool.ts`): Reusable SSH connections using `generic-pool`

**Dual Mode Support:**
- `SSH_USE_LOCAL_FS=true`: Direct local filesystem access (faster, for single-server deployments)
- `SSH_USE_LOCAL_FS=false`: Remote SSH/SFTP access (default, for remote servers)

### Authentication Flow

1. User submits credentials to `/api/auth/login`
2. Password verified via bcrypt hash or plain text fallback
3. Session created using `iron-session` (encrypted cookie-based)
4. Middleware validates session on all protected routes
5. Rate limiting: 5 login attempts/minute, 60 file operations/minute

**Session Details:**
- Cookie name: `canvas-notebook-session`
- Lifespan: 7 days
- Encryption: iron-session with `SESSION_SECRET` (32+ chars)
- Security: HttpOnly, Secure (in production), SameSite

## Critical Technical Constraints

### Native Modules

This project uses native Node.js modules (`ssh2`, `node-pty`) that require special handling:

- **Turbopack**: Disabled (`NEXT_DISABLE_TURBOPACK=1`) - native modules not supported
- **Webpack**: Required for builds (`next build --webpack`)
- **Externals**: `ssh2`, `node-pty`, `ssh2-sftp-client` marked as external in `next.config.ts`
- **Output Mode**: `standalone` for easier deployment

### WebSocket Handling

**IMPORTANT**: WebSocket connections require the custom server (`server.js`):

1. Never try to handle WebSockets in Next.js API routes - they don't support upgrades
2. WebSocket upgrade logic is in `server/terminal-server.js`
3. The custom server intercepts requests to `/api/terminal/*`
4. All other routes are forwarded to Next.js

### Connection Management

**File Operations vs Terminal:**
- File operations use a **connection pool** (reusable connections)
- Terminal sessions use **persistent SSH shells** (not pooled)
- These are **separate SSH connections** - don't mix them

**Pool Configuration** (`.env.local`):
```bash
SSH_POOL_MIN=0          # Minimum connections
SSH_POOL_MAX=5          # Maximum connections
SSH_POOL_IDLE_TIMEOUT=600000  # 10 minutes
```

## Important Code Patterns

### xterm.js Focus Management

The terminal has complex focus handling to prevent input loss. Key patterns in `XTerminal.tsx`:

```typescript
// Always focus terminal on pointer events (before preventDefault)
const handlePointerDown = (event: PointerEvent) => {
  term.focus();  // MUST be before preventDefault()
  // ... selection mode logic
};

// Single click handler (no duplicates)
container.addEventListener('click', handleFocus);
container.addEventListener('pointerdown', handlePointerDown);

// Reconnect on visibility change
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    term.focus();
  }
});
```

### WebSocket Reconnect Logic

The terminal implements automatic reconnection with exponential backoff:

```typescript
// In XTerminal.tsx
const connectWebSocket = () => {
  const socket = new WebSocket(wsUrl);

  socket.addEventListener('close', () => {
    if (isIntentionallyClosed.current) return;

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
    reconnectAttempts.current++;

    setTimeout(() => {
      if (!isIntentionallyClosed.current) {
        connectWebSocket();
      }
    }, delay);
  });
};
```

### State Management with Zustand

File and terminal state is managed with Zustand stores:

- `file-store.ts`: File tree, active file, upload/download state
- `terminal-store.ts`: Terminal sessions, active session

**Pattern**: Actions are async and update state when complete:
```typescript
loadFile: async (path: string) => {
  set({ loading: true });
  const content = await fetch(`/api/files/read?path=${path}`);
  set({ activeFile: content, loading: false });
}
```

## Environment Variables

Required variables in `.env.local`:

```bash
# SSH Configuration
SSH_HOST=ssh.canvas.holdings
SSH_PORT=22
SSH_USER=canvas-notebook
SSH_KEY_PATH=/home/ubuntu/.ssh/id_rsa  # or SSH_PASSWORD=...

# Authentication
APP_USERNAME=admin
APP_PASSWORD_HASH=$2b$10$...  # bcrypt hash
SESSION_SECRET=...  # 32+ character random string

# File System
SSH_BASE_PATH=/path/to/workspace
SSH_USE_LOCAL_FS=true  # true for local FS, false for remote SFTP

# Terminal Configuration
MAX_TERMINALS_PER_USER=3
TERMINAL_IDLE_TIMEOUT=1800000  # 30 minutes

# Connection Pool
SSH_POOL_MIN=0
SSH_POOL_MAX=5
SSH_POOL_IDLE_TIMEOUT=600000  # 10 minutes
```

## Common Issues & Solutions

### Terminal Input Not Working

**Symptoms**: Cursor visible but keyboard input doesn't work

**Root Causes**:
1. Focus lost (preventDefault blocking focus)
2. WebSocket connection dead (no reconnect)
3. Duplicate event handlers interfering

**Fixed In**: The terminal now has proper focus management and automatic reconnection.

### Native Module Build Errors

**Symptoms**: Build fails with "Module not found" for `ssh2` or `node-pty`

**Solution**:
1. Ensure `NEXT_DISABLE_TURBOPACK=1` is set
2. Use `next build --webpack` instead of `next build`
3. Check `next.config.ts` has correct `serverExternalPackages`

### WebSocket Connection Fails

**Symptoms**: Terminal shows "Connection error" or "Connection lost"

**Common Causes**:
1. Custom server not running (must use `server.js`, not `next dev`)
2. Session cookie not valid (user not authenticated)
3. SSH credentials incorrect in `.env.local`
4. SSH server unreachable

**Debug**:
```bash
# Check server logs
journalctl -u canvas-notebook.service -f

# Test SSH connection manually
ssh -i ~/.ssh/id_rsa canvas-notebook@ssh.canvas.holdings

# Verify WebSocket upgrade in browser DevTools (Network tab)
```

## Development Workflow

### Adding New File Operations

1. Create API route in `/app/api/files/[operation]/route.ts`
2. Use `getSFTPClient()` from `app/lib/ssh/sftp-client.ts`
3. Add rate limiting with `rateLimiter.check()`
4. Add action to `file-store.ts` for state management
5. Call from component (e.g., `FileContextMenu.tsx`)

### Modifying Terminal Behavior

1. **Client-side** (UI): Edit `app/components/terminal/XTerminal.tsx`
2. **WebSocket layer**: Edit `server/terminal-server.js`
3. **Session management**: Edit `server/terminal-manager.js`
4. **Message protocol**: All messages are JSON with `{ type, data }` structure

### Adding UI Components

Use shadcn/ui components from `/components/ui`:

```bash
# Components are already installed, just import:
import { Button } from '@/components/ui/button'
```

## Testing Considerations

- Tests run in local FS mode (`SSH_TEST_MODE=1`)
- Use `SESSION_SECURE_COOKIES=false` for HTTP testing
- Playwright tests expect server running on port 3001
- Smoke test validates basic app functionality
- Integration tests hit API endpoints directly

## Production Deployment Notes

- App runs as systemd service (`canvas-notebook.service`)
- Uses standalone output mode (`.next/standalone/`)
- Custom server handles WebSocket upgrades
- Traefik reverse proxy for SSL/TLS termination
- Cloudflare DNS and proxy enabled
- Live URL: https://chat.canvasstudios.store
