# syntax=docker/dockerfile:1.7

ARG NPM_VERSION=11.11.0
ARG NODE_BASE_IMAGE=node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG DEBIAN_SNAPSHOT=20260716T000000Z
ARG LIBVIPS_VERSION=8.18.3
ARG LIBVIPS_SHA256=f41285b61bfb495605494f074ca341f7791a1d406e2f157dcea606ef1ae1b146

FROM ${NODE_BASE_IMAGE} AS canvas-base
ARG DEBIAN_SNAPSHOT

# Every apt operation in Canvas-owned layers resolves against one immutable
# Debian archive state. Bootstrap ca-certificates from the same signed snapshot
# over HTTP because the slim base does not yet contain a CA store, then use
# HTTPS for every later apt operation. The base-image packages themselves
# remain bound by the immutable NODE_BASE_IMAGE digest.
RUN set -eux; \
  printf 'Types: deb deb-src\nURIs: http://snapshot.debian.org/archive/debian/%s/\nSuites: bookworm bookworm-updates\nComponents: main\nCheck-Valid-Until: no\n\nTypes: deb deb-src\nURIs: http://snapshot.debian.org/archive/debian-security/%s/\nSuites: bookworm-security\nComponents: main\nCheck-Valid-Until: no\n' \
    "${DEBIAN_SNAPSHOT}" "${DEBIAN_SNAPSHOT}" \
    > /etc/apt/sources.list.d/debian.sources; \
  rm -f /etc/apt/sources.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates; \
  rm -rf /var/lib/apt/lists/*; \
  sed -i 's#URIs: http://#URIs: https://#g' /etc/apt/sources.list.d/debian.sources

FROM canvas-base AS libvips-build
ARG LIBVIPS_VERSION
ARG LIBVIPS_SHA256

# Build a replaceable shared libvips from its exact upstream source instead of
# distributing the statically aggregated @img/sharp-libvips binaries.
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl meson ninja-build pkg-config \
    libarchive-dev libexif-dev libexpat1-dev libglib2.0-dev libheif-dev \
    libjpeg62-turbo-dev liblcms2-dev libpango1.0-dev libpng-dev \
    librsvg2-dev libtiff-dev libwebp-dev; \
  curl -fsSL --retry 3 \
    -o /tmp/vips-${LIBVIPS_VERSION}.tar.xz \
    "https://github.com/libvips/libvips/releases/download/v${LIBVIPS_VERSION}/vips-${LIBVIPS_VERSION}.tar.xz"; \
  echo "${LIBVIPS_SHA256}  /tmp/vips-${LIBVIPS_VERSION}.tar.xz" | sha256sum -c -; \
  tar -xJf /tmp/vips-${LIBVIPS_VERSION}.tar.xz -C /tmp; \
  meson setup "/tmp/vips-${LIBVIPS_VERSION}/build" "/tmp/vips-${LIBVIPS_VERSION}" \
    --prefix=/usr/local --libdir=lib --buildtype=release \
    -Ddeprecated=false -Dexamples=false -Ddocs=false \
    -Dintrospection=disabled -Dmodules=disabled \
    -Darchive=enabled -Dcgif=disabled -Dexif=enabled -Dfontconfig=enabled \
    -Dheif=enabled -Dheif-module=disabled -Dimagequant=disabled \
    -Djpeg=enabled -Duhdr=disabled -Djpeg-xl=disabled \
    -Djpeg-xl-module=disabled -Dlcms=enabled -Dmagick=disabled \
    -Dmatio=disabled -Dnifti=disabled -Dopenexr=disabled \
    -Dopenjpeg=disabled -Dopenslide=disabled -Dorc=disabled \
    -Dpangocairo=enabled -Dpdfium=disabled -Dpng=enabled \
    -Dpoppler=disabled -Dquantizr=disabled -Draw=disabled -Drsvg=enabled \
    -Dspng=disabled -Dtiff=enabled -Dwebp=enabled -Dzlib=enabled; \
  meson compile -C /tmp/vips-${LIBVIPS_VERSION}/build; \
  DESTDIR=/opt/libvips-root meson install -C /tmp/vips-${LIBVIPS_VERSION}/build; \
  test -f /opt/libvips-root/usr/local/lib/pkgconfig/vips-cpp.pc

FROM canvas-base AS app-base

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    libarchive13 libexif12 libexpat1 libfontconfig1 libglib2.0-0 libheif1 \
    libjpeg62-turbo liblcms2-2 libpango-1.0-0 libpangocairo-1.0-0 \
    libpng16-16 librsvg2-2 libtiff6 libwebp7 libwebpdemux2 libwebpmux3 zlib1g; \
  rm -rf /var/lib/apt/lists/*
COPY --from=libvips-build /opt/libvips-root/usr/local/ /usr/local/
COPY --from=libvips-build /tmp/vips-8.18.3.tar.xz /usr/share/canvas-notebook/corresponding-source/vips-8.18.3.tar.xz
RUN ldconfig && vips --version | grep -Fx vips-8.18.3

FROM app-base AS deps
WORKDIR /app
ARG NPM_VERSION
ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig \
    LD_LIBRARY_PATH=/usr/local/lib \
    NODE_PATH=/usr/local/lib/node_modules \
    SHARP_FORCE_GLOBAL_LIBVIPS=1

# Required for native modules (node-pty, better-sqlite3) and for compiling both
# Sharp versions against the source-built shared libvips. These development
# headers remain in the deps stage and are not copied into the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 make g++ pkg-config \
    libarchive-dev libexif-dev libexpat1-dev libglib2.0-dev libheif-dev \
    libjpeg62-turbo-dev liblcms2-dev libpango1.0-dev libpng-dev \
    librsvg2-dev libtiff-dev libwebp-dev \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@${NPM_VERSION} node-addon-api@8.9.0 node-gyp@12.4.0

COPY package.json package-lock.json .npmrc* ./
RUN npm ci --legacy-peer-deps --loglevel=warn \
  && npm --prefix node_modules/sharp run build \
  && npm --prefix node_modules/next/node_modules/sharp run build \
  && find node_modules -type d -path '*/@img/sharp-*' -prune -exec rm -rf '{}' +

FROM app-base AS builder
WORKDIR /app
ARG NPM_VERSION
ENV NODE_ENV=production \
    PKG_CONFIG_PATH=/usr/local/lib/pkgconfig \
    LD_LIBRARY_PATH=/usr/local/lib
RUN npm install -g npm@${NPM_VERSION}

COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN npm run build

# Remove devDependencies after build to reduce size
# BUT keep tsx for running TypeScript server files at runtime
RUN npm prune --production && npm install tsx \
  && find node_modules -type d -path '*/@img/sharp-*' -prune -exec rm -rf '{}' +

FROM app-base AS runner
WORKDIR /app
ARG APP_USER=node
ARG NODE_BASE_IMAGE
ARG DEBIAN_SNAPSHOT
ARG NPM_VERSION
ARG POSTGRES_CLIENT_VERSION=18.4-1.pgdg12+1
ARG POSTGRES_COMMON_VERSION=293.pgdg12+1
ARG TARGETPLATFORM

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ffmpeg curl wget zstd ca-certificates sqlite3 unzip zip git make python3 python3-pip python3-venv ripgrep poppler-utils procps \
     chromium fonts-liberation libnss3 libatk-bridge2.0-0 libcups2 libdrm2 \
     libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
     fonts-noto-color-emoji; \
  case "$(dpkg --print-architecture)" in \
    amd64) \
      pg_client_sha=21c9b6e141053fcecceddd5cb196a105eef9e0c5fd9d6d4f5b52a9b4693a871f; \
      pg_libpq_sha=e09e61eec1057fa11ee078ef357ad7bf3257c91f7f0f90681389bed2a99842b7 ;; \
    arm64) \
      pg_client_sha=8fbcd33a01b4603a55bf7e9a8d695b0114d0d1ca340f88771d59cd96ca65dd74; \
      pg_libpq_sha=414ce97cf223533003155708165d2a08fd38dc42df1c762ecb33d81a0415da67 ;; \
    *) echo "Unsupported PostgreSQL client architecture" >&2; exit 1 ;; \
  esac; \
  pg_arch="$(dpkg --print-architecture)"; \
  curl -fsSL --retry 3 -o /tmp/postgresql-client-common.deb \
    "https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-common/postgresql-client-common_${POSTGRES_COMMON_VERSION}_all.deb"; \
  curl -fsSL --retry 3 -o /tmp/libpq5.deb \
    "https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/libpq5_${POSTGRES_CLIENT_VERSION}_${pg_arch}.deb"; \
  curl -fsSL --retry 3 -o /tmp/postgresql-client.deb \
    "https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/postgresql-client-18_${POSTGRES_CLIENT_VERSION}_${pg_arch}.deb"; \
  echo "a4e2461975abffae23688fc95c4fdc97fea4c4c9cc096c2c4a7a4e334dfc3353  /tmp/postgresql-client-common.deb" | sha256sum -c -; \
  echo "${pg_libpq_sha}  /tmp/libpq5.deb" | sha256sum -c -; \
  echo "${pg_client_sha}  /tmp/postgresql-client.deb" | sha256sum -c -; \
  apt-get install -y --no-install-recommends /tmp/postgresql-client-common.deb /tmp/libpq5.deb /tmp/postgresql-client.deb; \
  rm -f /tmp/*.deb; \
  rm -rf /var/lib/apt/lists/*; \
  python3 --version; \
  pg_dump --version

# Install the exact cross-platform Python wheel set required by skills.
COPY --from=builder /app/requirements/runtime-python.txt /app/requirements/runtime-python.txt
RUN pip3 install --no-cache-dir --break-system-packages --require-hashes -r /app/requirements/runtime-python.txt
RUN npm install -g npm@${NPM_VERSION}

ENV NODE_ENV=production \
    CANVAS_RUNTIME_ENV=docker \
    CANVAS_APP_ROOT=/app \
    PKG_CONFIG_PATH=/usr/local/lib/pkgconfig \
    LD_LIBRARY_PATH=/usr/local/lib \
    CHROMIUM_PATH=/usr/bin/chromium \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA=/data \
    ALLOW_SIGNUP=false \
    NPM_CONFIG_PREFIX=/home/${APP_USER}/.npm-global \
    BUN_INSTALL=/data/cache/.bun \
    PATH=/data/cache/.bun/bin:/home/${APP_USER}/.npm-global/bin:${PATH} \
    CANVAS_TERMINAL_SOCKET=/tmp/canvas-terminal.sock \
    CANVAS_TERMINAL_USE_UNIX_SOCKET=true \
    XDG_CACHE_HOME=/data/cache

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/seed_skills ./seed_skills
COPY --from=builder /app/app ./app
COPY --from=builder /app/components ./components
COPY --from=builder /app/i18n ./i18n
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/messages ./messages
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/LICENSE ./LICENSE
COPY --from=builder /app/Dockerfile ./Dockerfile
COPY --from=builder /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --from=builder /app/docs/compliance ./docs/compliance

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

# Capture and verify the final OS/Python/npm/native payload only after the
# production node_modules and locally-built sharp addons are present.
RUN node ./scripts/capture-runtime-component-inventory.mjs \
  --base-image "${NODE_BASE_IMAGE}" \
  --platform "${TARGETPLATFORM}" \
  --debian-snapshot "${DEBIAN_SNAPSHOT}" \
  --output /app/docs/compliance/runtime-components.json
RUN node ./scripts/runtime-component-inventory-test.mjs \
  /app/docs/compliance/runtime-components.json \
  /app/requirements/runtime-python.txt
RUN node ./scripts/sharp-runtime-linkage-test.mjs \
  /app/docs/compliance/sharp-linkage.json

# Ensure scripts are executable
RUN mkdir -p /data/workspace /data/canvas-agent /data/pi-oauth-states /data/secrets /data/skills /data/plugins /data/cache /tmp
RUN chmod +x ./scripts/docker-entrypoint.sh ./scripts/start-services.sh
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

# Next.js development mode generates next-env.d.ts at the project root and can
# update tsconfig.json. Keep the runtime user able to make those small updates
# without recursively copying the whole application layer.
RUN chown ${APP_USER}:${APP_USER} /app /app/tsconfig.json

# Only chown /data and /home recursively (not /app to avoid layer duplication)
RUN chown -R ${APP_USER}:${APP_USER} /data /home/${APP_USER} /tmp

USER ${APP_USER}

EXPOSE 3000
VOLUME ["/data", "/home/node"]
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["./scripts/start-services.sh"]
