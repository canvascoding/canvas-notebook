# syntax=docker/dockerfile:1.7

ARG NPM_VERSION=11.11.0

FROM node:24-bookworm-slim AS deps
WORKDIR /app

# Required for native modules (node-pty, better-sqlite3)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@${NPM_VERSION}

COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g npm@${NPM_VERSION}

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Remove devDependencies after build to reduce size
RUN npm prune --production

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ARG APP_USER=node

# Install s6-overlay for process supervision
ADD https://github.com/just-containers/s6-overlay/releases/download/v3.1.6.2/s6-overlay-noarch.tar.xz /tmp
ADD https://github.com/just-containers/s6-overlay/releases/download/v3.1.6.2/s6-overlay-x86_64.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz && \
    rm /tmp/s6-overlay-*.tar.xz

RUN apt-get update \
  && apt-get install -y --no-install-recommends sudo ffmpeg curl zstd ca-certificates sqlite3 unzip \
  && rm -rf /var/lib/apt/lists/*
RUN echo "${APP_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${APP_USER} \
  && chmod 0440 /etc/sudoers.d/${APP_USER}
RUN npm install -g npm@${NPM_VERSION}

ENV NODE_ENV=production \
    CANVAS_RUNTIME_ENV=docker \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    WORKSPACE_DIR=/data/workspace \
    SQLITE_PATH=/data/sqlite.db \
    ALLOW_SIGNUP=false \
    NPM_CONFIG_PREFIX=/home/${APP_USER}/.npm-global \
    PATH=/home/${APP_USER}/.npm-global/bin:${PATH} \
    CANVAS_TERMINAL_SOCKET=/tmp/canvas-terminal.sock \
    CANVAS_TERMINAL_USE_UNIX_SOCKET=true \
    S6_KEEP_ENV=1

# Copy s6 service definitions
COPY ./s6-services /etc/s6-overlay/s6-rc.d

# Copy only standalone output (much smaller than full .next)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/skills ./skills

# Copy terminal service
COPY --from=builder /app/server ./server

# Copy production node_modules for external packages (better-auth, etc.)
COPY --from=builder /app/node_modules ./node_modules

RUN mkdir -p /data/workspace /data/canvas-agent /data/pi-oauth-states /data/secrets /data/skills /tmp
RUN chmod +x ./scripts/docker-entrypoint.sh
RUN printf '%s\n' \
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
VOLUME ["/data"]
ENTRYPOINT ["/init"]
CMD []
