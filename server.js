/* eslint-disable @typescript-eslint/no-require-imports */
const { loadEnvConfig } = require('@next/env');
const dev = process.env.NODE_ENV !== 'production';
loadEnvConfig(process.cwd(), dev);

const http = require('http');
const fs = require('fs');
const path = require('path');
const next = require('next');
const { attachTerminalServer } = require('./server/terminal-server');
const { terminateAllSessions } = require('./server/terminal-manager');
const { auth } = require('./app/lib/auth');

const port = parseInt(process.env.PORT || '3000', 10);
const hostname = process.env.HOSTNAME || 'localhost';
const app = next({ dev, hostname, port });
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

const MEDIA_ROOT = process.env.WORKSPACE_DIR || path.resolve(process.cwd(), 'data', 'workspace');
const SQLITE_PATH = process.env.SQLITE_PATH ? path.resolve(process.env.SQLITE_PATH) : null;
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

function ensureRuntimeDirectories() {
  try {
    fs.mkdirSync(path.resolve(MEDIA_ROOT), { recursive: true });
  } catch (error) {
    console.error(`[Startup] Failed to create WORKSPACE_DIR at ${MEDIA_ROOT}:`, error);
    throw error;
  }

  if (SQLITE_PATH) {
    try {
      fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
    } catch (error) {
      console.error(`[Startup] Failed to create SQLite directory for ${SQLITE_PATH}:`, error);
      throw error;
    }
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
  if (!filePath) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
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

ensureRuntimeDirectories();

app
  .prepare()
  .then(() => {
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

      if (url.pathname === '/api/terminal/kill' && req.method === 'POST') {
        getAuthSession(req)
          .then((sessionData) => {
            if (!sessionData || !sessionData.user) {
              res.statusCode = 401;
              res.setHeader('Content-Type', 'application/json');
              setNoIndexHeader(res);
              res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
              return;
            }

            const result = terminateAllSessions();
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            setNoIndexHeader(res);
            res.end(JSON.stringify({ success: true, closed: result.closed }));
          })
          .catch(() => {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            setNoIndexHeader(res);
            res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
          });
        return;
      }

      handle(req, res);
    });

    attachTerminalServer(server);

    server.listen(port, (err) => {
      if (err) throw err;
      console.log(`> Ready on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start server', error);
    process.exit(1);
  });
