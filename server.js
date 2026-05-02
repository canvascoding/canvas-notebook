/* eslint-disable @typescript-eslint/no-require-imports */
const { loadAppEnv } = require('./server/load-app-env');
loadAppEnv(process.cwd());

const { loadEnvConfig } = require('@next/env');
const dev = process.env.NODE_ENV !== 'production';
loadEnvConfig(process.cwd(), dev);

// The custom Node server is server-side code, but it imports some Next app
// modules directly for WebSocket runtime handling. Next aliases `server-only`
// during its own bundling; plain Node would otherwise execute the package's
// throwing stub.
const Module = require('module');
const path = require('path');
const originalLoad = Module._load;
const originalResolveFilename = Module._resolveFilename;
const piAiPackageRoot = path.resolve(process.cwd(), 'node_modules/@mariozechner/pi-ai/dist');
const piAiModuleAliases = new Map([
  ['@mariozechner/pi-ai', path.join(piAiPackageRoot, 'index.js')],
  ['@mariozechner/pi-ai/oauth', path.join(piAiPackageRoot, 'oauth.js')],
  ['@mariozechner/pi-ai/anthropic', path.join(piAiPackageRoot, 'providers/anthropic.js')],
  ['@mariozechner/pi-ai/azure-openai-responses', path.join(piAiPackageRoot, 'providers/azure-openai-responses.js')],
  ['@mariozechner/pi-ai/google', path.join(piAiPackageRoot, 'providers/google.js')],
  ['@mariozechner/pi-ai/google-vertex', path.join(piAiPackageRoot, 'providers/google-vertex.js')],
  ['@mariozechner/pi-ai/mistral', path.join(piAiPackageRoot, 'providers/mistral.js')],
  ['@mariozechner/pi-ai/openai-codex-responses', path.join(piAiPackageRoot, 'providers/openai-codex-responses.js')],
  ['@mariozechner/pi-ai/openai-completions', path.join(piAiPackageRoot, 'providers/openai-completions.js')],
  ['@mariozechner/pi-ai/openai-responses', path.join(piAiPackageRoot, 'providers/openai-responses.js')],
  ['@mariozechner/pi-ai/bedrock-provider', path.join(piAiPackageRoot, 'bedrock-provider.js')],
]);
Module._resolveFilename = function resolveWithEsmPackageAliases(request, parent, isMain, options) {
  const aliasedPath = piAiModuleAliases.get(request);
  if (aliasedPath) {
    return aliasedPath;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
Module._load = function loadWithServerOnlyMarker(request, parent, isMain) {
  if (request === 'server-only') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const http = require('http');
const fs = require('fs');
const next = require('next');
// Terminal service now runs as separate process via Unix Socket
// See server/terminal-service.ts
const { spawn } = require('child_process');
const { prepareSkillsRuntime } = require('./server/skills-runtime');
const { auth } = require('./app/lib/auth');
const {
  resolveSkillsDataDir,
} = require('./app/lib/runtime-data-paths');

const port = parseInt(process.env.PORT || '3000', 10);
const hostname = process.env.HOSTNAME || 'localhost';
const app = next({ dev, hostname, port, webpack: dev, turbopack: false });
const handle = app.getRequestHandler();

// Helper to get session from Node.js request using better-auth
async function getAuthSession(req) {
  try {
    const webHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        webHeaders.append(key, value);
      } else if (Array.isArray(value)) {
        for (const v of value) {
          webHeaders.append(key, v);
        }
      }
    }
    return await auth.api.getSession({ headers: webHeaders });
  } catch (e) {
    console.error('[Auth] Error verifying session:', e);
    return null;
  }
}

const DATA = process.env.DATA || path.resolve(process.cwd(), 'data');
const MEDIA_ROOT = path.join(DATA, 'workspace');
const SQLITE_PATH = path.join(DATA, 'sqlite.db');
const MEDIA_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
};

function setNoIndexHeader(res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate');
}

function resolveMediaPath(requestPath) {
  const basePath = path.resolve(MEDIA_ROOT);
  const normalized = path.resolve(basePath, requestPath);
  if (normalized === basePath || normalized.startsWith(`${basePath}${path.sep}`)) {
    return normalized;
  }
  return null;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MEDIA_TYPES[ext] || 'application/octet-stream';
}

function ensureSkillsDirectory() {
  try {
    const result = prepareSkillsRuntime({ cwd: process.cwd() });
    console.log(`[Startup] Skills synced to ${resolveSkillsDataDir()} (${result.commandSpecs.length} commands)`);
  } catch (error) {
    console.error('[Startup] Failed to sync skills directory:', error);
  }
}

function ensureRuntimeDirectories() {
  try {
    fs.mkdirSync(path.resolve(MEDIA_ROOT), { recursive: true });
    console.log(`[Startup] Ensured workspace directory exists: ${MEDIA_ROOT}`);
  } catch (error) {
    console.error(`[Startup] Failed to create WORKSPACE_DIR at ${MEDIA_ROOT}:`, error);
    throw error;
  }

  try {
    fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
    console.log(`[Startup] Ensured SQLite directory exists: ${path.dirname(SQLITE_PATH)}`);
  } catch (error) {
    console.error(`[Startup] Failed to create SQLite directory for ${SQLITE_PATH}:`, error);
    throw error;
  }

  // Ensure secrets directory exists for Canvas-Integrations.env
  const secretsDir = path.join(DATA, 'secrets');
  try {
    fs.mkdirSync(secretsDir, { recursive: true });
    console.log(`[Startup] Ensured secrets directory exists: ${secretsDir}`);
  } catch (error) {
    console.error(`[Startup] Failed to create secrets directory at ${secretsDir}:`, error);
    throw error;
  }
}

function serveMedia(req, res) {
  setNoIndexHeader(res);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const rawPath = url.pathname.replace(/^\/media\/?/, '');
  if (!rawPath) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }

  const filePath = resolveMediaPath(decodedPath);
  console.log(`[Media Debug] Request: ${decodedPath} -> Resolved: ${filePath} | MEDIA_ROOT: ${MEDIA_ROOT} | DATA: ${DATA}`);
  if (!filePath) {
    console.log(`[Media Debug] Forbidden: Path resolved to null`);
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      console.log(`[Media Debug] 404: File not found at ${filePath} | Error: ${statErr?.message || 'Not a file'}`);
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const totalSize = stats.size;
    const range = req.headers.range;
    const contentType = getContentType(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
    const isMedia = ['mp4', 'webm', 'ogv', 'mov', 'wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac'].includes(ext);
    const cacheControl = isImage
      ? 'private, max-age=300'
      : isMedia
        ? 'private, max-age=60'
        : 'no-store, max-age=0';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('X-Accel-Buffering', 'no');

    if (!range) {
      res.statusCode = 200;
      res.setHeader('Content-Length', totalSize);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      stream.on('error', () => {
        res.destroy();
      });
      stream.pipe(res);
      return;
    }

    const match = /bytes=(\d*)-(\d*)/i.exec(range);
    let start = 0;
    let end = totalSize - 1;
    if (match) {
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      if (!match[1] && match[2]) {
        const suffixLength = Number(match[2]);
        if (Number.isFinite(suffixLength)) {
          start = Math.max(totalSize - suffixLength, 0);
          end = totalSize - 1;
        }
      }
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalSize) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      res.end();
      return;
    }

    end = Math.min(end, totalSize - 1);
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath, {
      start,
      end,
      highWaterMark: 1024 * 1024,
    });
    stream.on('error', () => {
      res.destroy();
    });
    stream.pipe(res);
  });
}

// Run database migrations before anything else touches the DB
try {
  console.log('[Startup] Running database migrations...');
  const Database = require('better-sqlite3');
  const { runMigrations } = require('./app/lib/db/migrate');
  const dbPath = require('path').join(process.env.DATA || require('path').resolve(process.cwd(), 'data'), 'sqlite.db');
  require('fs').mkdirSync(require('path').dirname(dbPath), { recursive: true });
  const migrationDb = new Database(dbPath);
  runMigrations(migrationDb);
  migrationDb.close();
  console.log('[Startup] Database migrations completed');
} catch (error) {
  console.error('[Startup] CRITICAL ERROR in database migrations:', error.message);
  console.error('[Startup] Stack trace:', error.stack);
  process.exit(1);
}

// Ensure all runtime directories and tokens are set up before starting the server
console.log('[Startup] Starting runtime setup...');

try {
  console.log('[Startup] Calling ensureRuntimeDirectories()...');
  ensureRuntimeDirectories();
  console.log('[Startup] ensureRuntimeDirectories() completed');
} catch (error) {
  console.error('[Startup] CRITICAL ERROR in ensureRuntimeDirectories():', error.message);
  console.error('[Startup] Stack trace:', error.stack);
  // Continue anyway - don't block server startup
}

try {
  console.log('[Startup] Calling ensureSkillsDirectory()...');
  ensureSkillsDirectory();
  console.log('[Startup] ensureSkillsDirectory() completed');
} catch (error) {
  console.error('[Startup] ERROR in ensureSkillsDirectory():', error.message);
  console.error('[Startup] Stack trace:', error.stack);
}

try {
  console.log('[Startup] Running orphaned-assets cleanup...');
  const { cleanupOrphanedStudioAssets } = require('./app/lib/cleanup/orphaned-assets');
  cleanupOrphanedStudioAssets().then((result) => {
    console.log(`[Startup] Orphaned-assets cleanup: ${result.deleted} files deleted, ${result.errors.length} errors`);
  }).catch((err) => {
    console.warn('[Startup] Orphaned-assets cleanup failed:', err.message);
  });
} catch (err) {
  console.warn('[Startup] Orphaned-assets cleanup could not be loaded:', err.message);
}

try {
  console.log('[Startup] Seeding studio preset assets...');
  const { ensureDefaultStudioPresetsSeeded } = require('./app/lib/integrations/studio-preset-defaults');
  const { ensureStudioAssetsWorkspace } = require('./app/lib/integrations/studio-workspace');
  ensureStudioAssetsWorkspace().then(() => {
    return ensureDefaultStudioPresetsSeeded();
  }).then((result) => {
    console.log(`[Startup] Studio preset seeding: ${result.total} presets (${result.inserted} inserted, ${result.updated} updated)`);
  }).catch((err) => {
    console.warn('[Startup] Studio preset seeding failed:', err.message);
  });
} catch (err) {
  console.warn('[Startup] Studio preset seeding could not be loaded:', err.message);
}

// Spawn the standalone HTTP-based scheduler as a child process.
// This avoids the ESM-only dependency chain (pi-agent-core → pi-ai) that
// cannot be loaded via tsx's CJS transform in server.js.
try {
  console.log('[Startup] Spawning automation-scheduler...');
  const schedulerProcess = spawn(process.execPath, [path.resolve(__dirname, 'scripts/automation-scheduler.js')], {
    env: process.env,
    stdio: 'inherit',
  });
  schedulerProcess.on('error', (err) => {
    console.error('[Startup] automation-scheduler spawn error:', err.message);
  });
  process.on('exit', () => schedulerProcess.kill());
  console.log('[Startup] automation-scheduler spawned (pid %d)', schedulerProcess.pid);
} catch (error) {
  console.error('[Startup] ERROR spawning automation-scheduler:', error.message);
}

console.log('[Startup] Runtime setup complete');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/media/')) {
    getAuthSession(req)
      .then((sessionData) => {
        if (!sessionData || !sessionData.user) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          setNoIndexHeader(res);
          res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
          return;
        }
        serveMedia(req, res);
      })
      .catch(() => {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        setNoIndexHeader(res);
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      });
    return;
  }

  // Terminal kill endpoint is now handled by Next.js API routes
  // See app/api/terminal/kill/route.ts

  handle(req, res);
});

// Register the chat WebSocket handler before Next attaches its own upgrade
// listeners. After app.prepare() we wrap Next's listeners so they never see
// /ws/chat sockets; otherwise Next can still corrupt or close the upgraded
// connection after our ws server has accepted it.
let isChatWebSocketRequest = () => false;

function guardNonChatUpgradeListener(listener) {
  if (typeof listener !== 'function' || listener.__canvasUpgradeGuarded) {
    return listener;
  }

  const guardedListener = function guardedUpgradeListener(request, socket, head) {
    if (isChatWebSocketRequest(request.url)) {
      return;
    }

    return listener.call(this, request, socket, head);
  };
  guardedListener.__canvasUpgradeGuarded = true;
  guardedListener.__canvasOriginalListener = listener;
  return guardedListener;
}

function installChatUpgradeGuard(targetServer) {
  const originalOn = targetServer.on.bind(targetServer);
  const originalAddListener = targetServer.addListener.bind(targetServer);
  const originalPrependListener = targetServer.prependListener.bind(targetServer);
  const originalOnce = targetServer.once.bind(targetServer);
  const originalPrependOnceListener = targetServer.prependOnceListener.bind(targetServer);

  targetServer.on = function guardedOn(eventName, listener) {
    return originalOn(eventName, eventName === 'upgrade' ? guardNonChatUpgradeListener(listener) : listener);
  };
  targetServer.addListener = function guardedAddListener(eventName, listener) {
    return originalAddListener(eventName, eventName === 'upgrade' ? guardNonChatUpgradeListener(listener) : listener);
  };
  targetServer.prependListener = function guardedPrependListener(eventName, listener) {
    return originalPrependListener(eventName, eventName === 'upgrade' ? guardNonChatUpgradeListener(listener) : listener);
  };
  targetServer.once = function guardedOnce(eventName, listener) {
    return originalOnce(eventName, eventName === 'upgrade' ? guardNonChatUpgradeListener(listener) : listener);
  };
  targetServer.prependOnceListener = function guardedPrependOnceListener(eventName, listener) {
    return originalPrependOnceListener(eventName, eventName === 'upgrade' ? guardNonChatUpgradeListener(listener) : listener);
  };
}

async function startServer() {
  console.log('[Startup] Initializing WebSocket Server...');
  try {
    const websocketModule = await import('./server/websocket-server.ts');
    const websocketServer = websocketModule.createWebSocketServer
      ? websocketModule
      : websocketModule.default || websocketModule['module.exports'];
    if (
      !websocketServer ||
      typeof websocketServer.createWebSocketServer !== 'function' ||
      typeof websocketServer.isChatWebSocketRequest !== 'function'
    ) {
      throw new Error('WebSocket server module did not expose expected functions');
    }
    isChatWebSocketRequest = websocketServer.isChatWebSocketRequest;
    websocketServer.createWebSocketServer(server);
    console.log('[Startup] WebSocket Server ready on ws://localhost:' + port + '/ws/chat');
  } catch (error) {
    console.error('[Startup] ERROR initializing WebSocket Server:', error.message);
    console.error('[Startup] Stack trace:', error.stack);
    isChatWebSocketRequest = () => false;
  }

  installChatUpgradeGuard(server);

  await app.prepare();

  server.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${port}`);
  });
}

startServer().catch((error) => {
    console.error('Failed to start server', error);
    process.exit(1);
});
