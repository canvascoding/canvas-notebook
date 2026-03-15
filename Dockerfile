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
    PATH=/home/${APP_USER}/.npm-global/bin:${PATH}

# Copy only standalone output (much smaller than full .next)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/skills ./skills

# Copy production node_modules for external packages (better-auth, etc.)
COPY --from=builder /app/node_modules ./node_modules

RUN mkdir -p /data/workspace /data/canvas-agent /data/pi-oauth-states /data/secrets /data/skills
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
RUN chown -R ${APP_USER}:${APP_USER} /data /home/${APP_USER}

USER ${APP_USER}

EXPOSE 3000
VOLUME ["/data"]
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["node", "server.js"]
