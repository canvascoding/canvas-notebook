# syntax=docker/dockerfile:1.7

ARG NPM_VERSION=11.11.0

FROM node:24-bookworm-slim AS deps
WORKDIR /app

# Required for native modules (node-pty, better-sqlite3)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@${NPM_VERSION}

COPY package.json package-lock.json .npmrc* ./
RUN npm ci --legacy-peer-deps 2>&1 | tail -20 || npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g npm@${NPM_VERSION}

COPY --from=deps /app/node_modules ./node_modules
COPY . .
  ENV NODE_OPTIONS=--max-old-space-size=6144
  RUN npm run build

# Remove devDependencies after build to reduce size
# BUT keep tsx for running TypeScript server files at runtime
RUN npm prune --production && npm install tsx

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ARG APP_USER=node

RUN apt-get update \
  && apt-get install -y --no-install-recommends sudo ffmpeg curl zstd ca-certificates sqlite3 unzip zip git make python3 python3-pip python3-venv ripgrep \
     chromium fonts-liberation libnss3 libatk-bridge2.0-0 libcups2 libdrm2 \
     libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
     fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* \
  && python3 --version

# Install Python packages required by skills
RUN pip3 install --no-cache-dir --break-system-packages openpyxl pypdf pdfplumber pdf2image Pillow defusedxml lxml PyYAML python-pptx python-docx pandas numpy chardet beautifulsoup4 rich tabulate markitdown
RUN echo "${APP_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${APP_USER} && \
    chmod 0440 /etc/sudoers.d/${APP_USER}
RUN npm install -g npm@${NPM_VERSION}

ENV NODE_ENV=production \
    CANVAS_RUNTIME_ENV=docker \
    CANVAS_APP_ROOT=/app \
    CHROMIUM_PATH=/usr/bin/chromium \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA=/data \
    ALLOW_SIGNUP=false \
    NPM_CONFIG_PREFIX=/home/${APP_USER}/.npm-global \
    BUN_INSTALL=/data/cache/.bun \
    PATH=/data/skills/bin:/data/cache/.bun/bin:/home/${APP_USER}/.npm-global/bin:${PATH} \
    CANVAS_TERMINAL_SOCKET=/tmp/canvas-terminal.sock \
    CANVAS_TERMINAL_USE_UNIX_SOCKET=true \
    XDG_CACHE_HOME=/data/cache

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/app ./app
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Copy the main server.js file that initializes WebSocket server
COPY --from=builder /app/server.js ./server.js

# Copy runtime server TypeScript files (will be executed with tsx)
COPY --from=builder /app/server ./server

# Copy scripts from builder (needed for startup)
COPY --from=builder /app/scripts ./scripts

# Copy seed assets (preset preview images, sys prompts, etc.)
COPY --from=builder /app/seed_sys_prompts ./seed_sys_prompts

# Copy production node_modules for external packages (better-auth, etc.)
COPY --from=builder /app/node_modules ./node_modules

# Ensure scripts are executable
RUN mkdir -p /data/workspace /data/canvas-agent /data/pi-oauth-states /data/secrets /data/skills /data/cache /tmp
RUN chmod +x ./scripts/docker-entrypoint.sh ./scripts/start-services.sh
RUN printf '%s\n' \
  'SKILLS_BIN="/data/skills/bin"' \
  'case ":$PATH:" in' \
  '  *":$SKILLS_BIN:"*) ;;' \
  '  *) PATH="$SKILLS_BIN:$PATH" ;;' \
  'esac' \
  'NPM_GLOBAL_BIN="/home/node/.npm-global/bin"' \
  'case ":$PATH:" in' \
  '  *":$NPM_GLOBAL_BIN:"*) ;;' \
  '  *) PATH="$NPM_GLOBAL_BIN:$PATH" ;;' \
  'esac' \
  'export PATH' \
  > /etc/profile.d/npm-global-path.sh \
  && chmod 0644 /etc/profile.d/npm-global-path.sh
RUN mkdir -p /home/${APP_USER}/.npm-global

# Create and set permissions for Next.js cache directory
RUN mkdir -p /app/.next/cache && chown -R ${APP_USER}:${APP_USER} /app/.next

# Only chown /data and /home (not /app to avoid layer duplication)
RUN chown -R ${APP_USER}:${APP_USER} /data /home/${APP_USER} /tmp

USER ${APP_USER}

EXPOSE 3000
VOLUME ["/data", "/home/node"]
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["./scripts/start-services.sh"]
