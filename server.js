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

function getExportTarget(exportValue) {
  if (typeof exportValue === 'string') {
    return exportValue;
  }
  if (!exportValue || typeof exportValue !== 'object') {
    return null;
  }
  return exportValue.import || exportValue.default || exportValue.require || null;
}

function addEsmOnlyPackageAliases(packageName, aliases) {
  const packageRoot = path.resolve(process.cwd(), 'node_modules', packageName);
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJson = require(packageJsonPath);
  const exportsMap = packageJson.exports && typeof packageJson.exports === 'object'
    ? packageJson.exports
    : { '.': packageJson.main || './dist/index.js' };

  for (const [exportPath, exportValue] of Object.entries(exportsMap)) {
    const target = getExportTarget(exportValue);
    if (!target) {
      continue;
    }
    const request = exportPath === '.'
      ? packageName
      : `${packageName}/${exportPath.replace(/^\.\//, '')}`;
    aliases.set(request, path.resolve(packageRoot, target));
  }
}

const esmOnlyPackageAliases = new Map();
addEsmOnlyPackageAliases('@earendil-works/pi-ai', esmOnlyPackageAliases);
addEsmOnlyPackageAliases('@earendil-works/pi-agent-core', esmOnlyPackageAliases);

Module._resolveFilename = function resolveWithEsmPackageAliases(request, parent, isMain, options) {
  const aliasedPath = esmOnlyPackageAliases.get(request);
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
const { auth } = require('./app/lib/auth');
const {
  resolveSkillsDataDir,
} = require('./app/lib/runtime-data-paths');

const port = parseInt(process.env.PORT || '3000', 10);
const hostname = process.env.HOSTNAME || 'localhost';
const useWebpackDev = dev && process.env.CANVAS_DEV_BUNDLER === 'webpack';
if (dev) {
  console.log(`[Startup] Next.js dev bundler: ${useWebpackDev ? 'webpack' : 'turbopack'}`);
}
const app = next({
  dev,
  hostname,
  port,
  ...(useWebpackDev ? { webpack: true, turbopack: false } : {}),
});
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

const RETIRED_SEED_SKILLS = [
  {
    name: 'browser-tools',
    marker: 'author: canvas-studios',
  },
];

function cleanupRetiredSeedSkills(skillsDir) {
  for (const skill of RETIRED_SEED_SKILLS) {
    const skillDir = path.join(skillsDir, skill.name);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      continue;
    }

    const skillMd = fs.readFileSync(skillMdPath, 'utf8');
    if (!skillMd.includes(`name: ${skill.name}`) || !skillMd.includes(skill.marker)) {
      console.warn(`[Startup] Retired seed skill "${skill.name}" exists but did not match Canvas seed markers; preserving it.`);
      continue;
    }

    fs.rmSync(skillDir, { recursive: true, force: true });
    console.log(`[Startup] Removed retired seed skill: ${skill.name}`);
  }
}

function syncSeedSkills(repoSkillsDir, skillsDir) {
  const copyOptions = {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  };
  const skillsRoot = path.resolve(skillsDir);
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.cpSync(repoSkillsDir, skillsDir, copyOptions);
      return;
    } catch (error) {
      const targetPath = typeof error?.path === 'string' ? path.resolve(error.path) : null;
      const canRetry =
        error?.code === 'EEXIST' &&
        targetPath &&
        targetPath !== skillsRoot &&
        targetPath.startsWith(`${skillsRoot}${path.sep}`);

      if (!canRetry || attempt === maxAttempts) {
        throw error;
      }

      console.warn(`[Startup] Replacing existing seed skill path before retry: ${targetPath}`);
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  }
}

function ensureSkillsDirectory() {
  const skillsDir = resolveSkillsDataDir(process.cwd());
  const repoSkillsDir = path.resolve(process.cwd(), 'seed_skills');

  try {
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
      console.log(`[Startup] Created skills directory: ${skillsDir}`);
    }
    if (fs.existsSync(repoSkillsDir)) {
      syncSeedSkills(repoSkillsDir, skillsDir);
      console.log(`[Startup] Synced seed skills to ${skillsDir}`);
    }
    cleanupRetiredSeedSkills(skillsDir);
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

console.log('[Startup] Runtime setup complete');

function runOrphanedAssetsCleanup() {
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
}

function runStudioPresetSeeding() {
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
}

function scheduleExpiredSessionCleanup() {
  try {
    const { openDb } = require('./app/lib/db/index');
    const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
    async function purgeExpiredSessions() {
      try {
        const dbConn = await openDb();
        const result = dbConn.run("DELETE FROM session WHERE expires_at < unixepoch()");
        if (result.changes > 0) {
          console.log(`[Session Cleanup] Deleted ${result.changes} expired session(s)`);
        }
        dbConn.run("PRAGMA optimize");
        dbConn.close();
      } catch (err) {
        console.warn('[Session Cleanup] Failed:', err.message);
      }
    }
    purgeExpiredSessions();
    setInterval(purgeExpiredSessions, CLEANUP_INTERVAL_MS).unref?.();
    console.log('[Startup] Expired session cleanup scheduled (every 15min)');
  } catch (err) {
    console.warn('[Startup] Session cleanup could not be initialized:', err.message);
  }
}

function scheduleBackgroundMaintenance() {
  const timer = setTimeout(() => {
    console.log('[Startup] Starting background maintenance...');
    runOrphanedAssetsCleanup();
    runStudioPresetSeeding();
    scheduleExpiredSessionCleanup();
  }, 1500);
  timer.unref?.();
  console.log('[Startup] Background maintenance scheduled');
}

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

let shutdownInProgress = false;

function exitCodeForSignal(signal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 0;
}

function shutdownServer(signal) {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;

  console.log(`[Startup] Received ${signal}; closing HTTP server...`);
  const forceExitTimer = setTimeout(() => {
    console.warn(`[Startup] Forced exit after ${signal}; HTTP server did not close in time`);
    process.exit(exitCodeForSignal(signal));
  }, 10_000);
  forceExitTimer.unref?.();

  server.close((error) => {
    if (error) {
      console.error(`[Startup] Error while closing HTTP server after ${signal}:`, error);
      process.exit(1);
    }
    console.log(`[Startup] HTTP server closed after ${signal}`);
    process.exit(exitCodeForSignal(signal));
  });
}

process.on('SIGTERM', () => shutdownServer('SIGTERM'));
process.on('SIGINT', () => shutdownServer('SIGINT'));
process.on('uncaughtException', (error) => {
  console.error('[Startup] Uncaught exception:', error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Startup] Unhandled rejection:', reason);
  process.exit(1);
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
    if (process.env.CANVAS_ALLOW_HTTP_WITHOUT_CHAT_WS !== 'true') {
      throw error;
    }
  }

  installChatUpgradeGuard(server);

  // Channel Manager start (Telegram polling etc.)
  try {
    const { getChannelManager } = require('./app/lib/channels/manager.ts');
    const manager = getChannelManager();
    await manager.start();
    console.log('[Startup] Channel Manager started');
  } catch (error) {
    console.error('[Startup] Channel Manager failed:', error.message);
  }

  console.log('[Startup] Preparing Next.js app...');
  await app.prepare();
  console.log('[Startup] Next.js app prepared');

  server.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${port}`);
    scheduleBackgroundMaintenance();
  });
}

startServer().catch((error) => {
    console.error('Failed to start server', error);
    process.exit(1);
});
