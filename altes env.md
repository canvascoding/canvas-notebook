# SSH Configuration
SSH_HOST=ssh.canvas.holdings
SSH_PORT=22
SSH_USER=canvas-notebook
# SSH Key-based authentication (password removed for security)
SSH_KEY_PATH=/home/ubuntu/.ssh/canvas-notebook-ed25519

# App Configuration - SECURITY: Change these in production!
APP_USERNAME=admin
APP_PASSWORD_HASH=$2b$10$EoOQ51boAmELiTREF0iS8eJUi2X9Ocbdbv1GS1sM0ksB5uKwkYipO
APP_PASSWORD=canvas2026!
SESSION_SECRET=0DmVUwqY95tTRC0x1GQgECnZKPkCggiFnfVg0xt54hY=

# File System - Path to workspace folder
SSH_BASE_PATH=/home/canvas-notebook/workspace
SSH_USE_LOCAL_FS=true

# Terminal Configuration
MAX_TERMINALS_PER_USER=3
TERMINAL_IDLE_TIMEOUT=1800000

# Connection Pool Settings
SSH_POOL_MAX=5
SSH_POOL_MIN=0
SSH_POOL_IDLE_TIMEOUT=600000

# Claude Code Auto-Start
CLAUDE_CODE_AUTO_START=true

# Next.js
NEXT_PUBLIC_WS_URL=wss://chat.canvasstudios.store
NEXT_PUBLIC_MEDIA_BASE_URL=https://chat.canvasstudios.store
