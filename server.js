/* eslint-disable @typescript-eslint/no-require-imports */
const { loadAppEnv } = require('./server/load-app-env');
loadAppEnv(process.cwd());

const { loadEnvConfig } = require('@next/env');
const dev = process.env.NODE_ENV !== 'production';
loadEnvConfig(process.cwd(), dev);

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const next = require('next');
// Terminal service now runs as separate process via Unix Socket
// See server/terminal-service.ts
const { startAutomationScheduler } = require('./server/automation-scheduler');
const { auth } = require('./app/lib/auth');
const {
  resolveAgentStorageDir,
  resolveSkillsDataDir,
  resolveSkillsTokenPath,
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

const AGENT_STORAGE_DIR = resolveAgentStorageDir();
const SKILLS_TOKEN_PATH = resolveSkillsTokenPath();
const SKILLS_REPO_DIR = path.resolve(process.cwd(), 'skills');
const SKILLS_DATA_DIR = resolveSkillsDataDir();

function ensureSkillsToken() {
  console.log('[Startup] ensureSkillsToken() started - DATA path:', DATA);
  console.log('[Startup] SKILLS_TOKEN_PATH:', SKILLS_TOKEN_PATH);
  
  try {
    fs.mkdirSync(AGENT_STORAGE_DIR, { recursive: true });
    console.log('[Startup] Created agent storage directory:', AGENT_STORAGE_DIR);
    
    let token;
    let isNewToken = false;
    
    try {
      token = fs.readFileSync(SKILLS_TOKEN_PATH, 'utf8').trim();
      console.log(`[Startup] Loaded existing skills token from ${SKILLS_TOKEN_PATH}`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error(`[Startup] Error reading skills token file: ${e.message}`);
        throw e;
      }
      token = crypto.randomBytes(32).toString('hex');
      isNewToken = true;
      try {
        fs.writeFileSync(SKILLS_TOKEN_PATH, token + '\n', { encoding: 'utf8', mode: 0o600 });
        console.log(`[Startup] Generated new skills token at ${SKILLS_TOKEN_PATH}`);
      } catch (writeError) {
        console.error(`[Startup] Failed to write skills token file: ${writeError.message}`);
        throw writeError;
      }
    }
    
    process.env.CANVAS_SKILLS_TOKEN = token;
    console.log('[Startup] Set CANVAS_SKILLS_TOKEN in process.env');
    
    // Also save to Canvas-Integrations.env for centralized access
    const integrationsEnvPath = path.join(DATA, 'secrets', 'Canvas-Integrations.env');
    console.log('[Startup] Will save token to:', integrationsEnvPath);
    
    try {
      // Ensure directory exists
      const secretsDir = path.dirname(integrationsEnvPath);
      try {
        fs.mkdirSync(secretsDir, { recursive: true });
        console.log(`[Startup] Ensured secrets directory exists: ${secretsDir}`);
      } catch (mkdirError) {
        console.error(`[Startup] Failed to create secrets directory: ${mkdirError.message}`);
        throw mkdirError;
      }
      
      // Check write permissions
      try {
        fs.accessSync(secretsDir, fs.constants.W_OK);
        console.log('[Startup] Have write permissions for secrets directory');
      } catch (permError) {
        console.error(`[Startup] No write permissions for secrets directory: ${permError.message}`);
        throw permError;
      }
      
      // Read existing content
      let envContent = '';
      let lines = [];
      try {
        envContent = fs.readFileSync(integrationsEnvPath, 'utf8');
        lines = envContent.split('\n');
        console.log(`[Startup] Read existing integrations env file (${lines.length} lines)`);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.error(`[Startup] Error reading integrations env file: ${e.message}`);
          throw e;
        }
        console.log(`[Startup] Integrations env file does not exist yet, will create new one`);
      }
      
      // Find and update/remove all existing CANVAS_SKILLS_TOKEN entries
      const tokenKey = 'CANVAS_SKILLS_TOKEN';
      let foundExisting = false;
      let updatedLines = [];
      
      for (const line of lines) {
        if (line.startsWith(`${tokenKey}=`)) {
          const existingValue = line.substring(tokenKey.length + 1).trim();
          if (existingValue === token) {
            console.log(`[Startup] Token already exists in integrations env with same value`);
            foundExisting = true;
            updatedLines.push(line); // Keep existing line
          } else {
            console.log(`[Startup] Updating existing token in integrations env (old value different)`);
            foundExisting = true;
            updatedLines.push(`${tokenKey}=${token}`);
          }
        } else if (line.trim() !== '') {
          updatedLines.push(line);
        }
      }
      
      // If no existing token found, add it
      if (!foundExisting) {
        console.log(`[Startup] Adding new CANVAS_SKILLS_TOKEN to integrations env`);
        updatedLines.push(`${tokenKey}=${token}`);
      }
      
      // Ensure file ends with newline
      const newContent = updatedLines.join('\n') + (updatedLines.length > 0 ? '\n' : '');
      
      // Atomic write: write to temp file first, then rename
      const tempPath = `${integrationsEnvPath}.tmp`;
      try {
        fs.writeFileSync(tempPath, newContent, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tempPath, integrationsEnvPath);
        console.log(`[Startup] Successfully saved CANVAS_SKILLS_TOKEN to ${integrationsEnvPath}`);
      } catch (writeError) {
        console.error(`[Startup] Failed to write integrations env file: ${writeError.message}`);
        // Try to clean up temp file
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
        throw writeError;
      }
      
      // Verify the write was successful
      try {
        const verifyContent = fs.readFileSync(integrationsEnvPath, 'utf8');
        const verifyLines = verifyContent.split('\n');
        const verifyTokenLine = verifyLines.find(line => line.startsWith(`${tokenKey}=`));
        if (verifyTokenLine) {
          const verifyValue = verifyTokenLine.substring(tokenKey.length + 1).trim();
          if (verifyValue === token) {
            console.log(`[Startup] Verified: CANVAS_SKILLS_TOKEN is correctly saved in integrations env`);
          } else {
            console.error(`[Startup] Verification failed: Token value mismatch in integrations env`);
          }
        } else {
          console.error(`[Startup] Verification failed: CANVAS_SKILLS_TOKEN not found in integrations env after write`);
        }
      } catch (verifyError) {
        console.error(`[Startup] Failed to verify integrations env file: ${verifyError.message}`);
      }
      
    } catch (envError) {
      console.error('[Startup] Failed to save skills token to integrations env:', envError.message);
      console.error('[Startup] Stack trace:', envError.stack);
    }
  } catch (error) {
    console.error('[Startup] Failed to ensure skills token:', error.message);
    console.error('[Startup] Stack trace:', error.stack);
  }
}

const SKILL_COMMANDS = ['image-generation', 'video-generation', 'ad-localization'];

function ensureSkillsDirectory() {
  try {
    if (!fs.existsSync(SKILLS_REPO_DIR)) {
      return;
    }
    fs.mkdirSync(SKILLS_DATA_DIR, { recursive: true });
    fs.cpSync(SKILLS_REPO_DIR, SKILLS_DATA_DIR, { recursive: true, force: true });
    const skillBin = path.join(SKILLS_DATA_DIR, 'skill');
    if (fs.existsSync(skillBin)) {
      fs.chmodSync(skillBin, 0o755);
    }
    const wrapperDir = path.join(SKILLS_DATA_DIR, 'bin');
    fs.mkdirSync(wrapperDir, { recursive: true });

    for (const name of SKILL_COMMANDS) {
      const wrapperPath = path.join(wrapperDir, name);
      const content = `#!/usr/bin/env bash\nexec "${SKILLS_DATA_DIR}/skill" ${name} "$@"\n`;
      fs.writeFileSync(wrapperPath, content, { encoding: 'utf8', mode: 0o755 });
    }

    const currentPath = process.env.PATH || '';
    if (!currentPath.split(path.delimiter).includes(wrapperDir)) {
      process.env.PATH = `${wrapperDir}${path.delimiter}${currentPath}`;
    }

    console.log(`[Startup] Skills synced to ${SKILLS_DATA_DIR}`);

    // Best effort only: install global wrappers when the runtime allows it.
    if (process.env.CANVAS_RUNTIME_ENV === 'docker') {
      for (const name of SKILL_COMMANDS) {
        const wrapperPath = `/usr/local/bin/${name}`;
        const content = `#!/usr/bin/env bash\nexec "${SKILLS_DATA_DIR}/skill" ${name} "$@"\n`;
        try {
          fs.writeFileSync(wrapperPath, content, { encoding: 'utf8', mode: 0o755 });
        } catch (e) {
          console.warn(`[Startup] Could not install global wrapper for ${name}:`, e.message);
        }
      }
    }
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
  console.log('[Startup] Calling ensureSkillsToken()...');
  ensureSkillsToken();
  console.log('[Startup] ensureSkillsToken() completed successfully');
} catch (error) {
  console.error('[Startup] CRITICAL ERROR in ensureSkillsToken():', error.message);
  console.error('[Startup] Stack trace:', error.stack);
  // Continue anyway - server can still run without skills token
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
  console.log('[Startup] Calling startAutomationScheduler()...');
  startAutomationScheduler();
  console.log('[Startup] startAutomationScheduler() completed');
} catch (error) {
  console.error('[Startup] ERROR in startAutomationScheduler():', error.message);
  console.error('[Startup] Stack trace:', error.stack);
}

console.log('[Startup] Runtime setup complete');

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

      // Terminal kill endpoint is now handled by Next.js API routes
      // See app/api/terminal/kill/route.ts

      handle(req, res);
    });

    // Terminal service now runs as separate process
    // WebSocket upgrade handling removed - using SSE via API routes instead

    server.listen(port, (err) => {
      if (err) throw err;
      console.log(`> Ready on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start server', error);
    process.exit(1);
  });
