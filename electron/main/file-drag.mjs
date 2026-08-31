import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_DRAG_ITEMS = 25;
const CACHE_TTL_MS = 10 * 60 * 1000;

function isSafeWorkspacePath(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized.includes('\\')) return false;
  return normalized.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

export function normalizeDesktopFileDragRequest(value) {
  if (!value || typeof value !== 'object') return null;
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId.trim() : '';
  if (!workspaceId || !Array.isArray(value.paths)) return null;

  const paths = Array.from(new Set(value.paths.map((pathValue) => (
    typeof pathValue === 'string' ? pathValue.trim() : ''
  ))));
  if (paths.length === 0 || paths.length > MAX_DRAG_ITEMS || !paths.every(isSafeWorkspacePath)) return null;

  return { workspaceId, paths };
}

function cacheKey(workspaceId, filePath) {
  return `${workspaceId}\0${filePath}`;
}

function safeDownloadName(filePath, response) {
  const baseName = path.posix.basename(filePath).replace(/[^a-zA-Z0-9._ -]/g, '_') || 'download';
  const contentType = response.headers.get('content-type') || '';
  return contentType.startsWith('application/zip') && !baseName.toLowerCase().endsWith('.zip')
    ? `${baseName}.zip`
    : baseName;
}

function buildDownloadUrl(serverUrl, workspaceId, filePath) {
  const url = new URL('/api/files/download', serverUrl);
  url.searchParams.set('path', filePath);
  url.searchParams.set('workspaceId', workspaceId);
  return url.toString();
}

export function createDesktopFileDragCache({ tempRoot, iconPath, cacheTtlMs = CACHE_TTL_MS }) {
  const cachedFiles = new Map();
  const pendingDownloads = new Map();
  let tempRootReady = null;

  const ensureTempRoot = async () => {
    if (!tempRootReady) {
      tempRootReady = mkdir(tempRoot, { recursive: true });
    }
    await tempRootReady;
  };

  const removeCachedFile = async (key) => {
    const entry = cachedFiles.get(key);
    if (!entry) return;
    cachedFiles.delete(key);
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    await rm(entry.localPath, { force: true });
  };

  const cacheFile = (key, localPath) => {
    const cleanupTimer = setTimeout(() => {
      void removeCachedFile(key);
    }, cacheTtlMs);
    cleanupTimer.unref?.();
    cachedFiles.set(key, { localPath, cleanupTimer });
    return localPath;
  };

  const downloadFile = async (webContents, serverUrl, workspaceId, filePath) => {
    const key = cacheKey(workspaceId, filePath);
    const cached = cachedFiles.get(key);
    if (cached) return cached.localPath;

    const pending = pendingDownloads.get(key);
    if (pending) return pending;

    const download = (async () => {
      await ensureTempRoot();
      const response = await webContents.session.fetch(
        buildDownloadUrl(serverUrl, workspaceId, filePath),
        { headers: { 'x-canvas-workspace-id': workspaceId } },
      );
      if (!response.ok || !response.body) {
        throw new Error(`Could not prepare ${filePath} for drag-and-drop.`);
      }

      const localPath = path.join(tempRoot, `${randomUUID()}-${safeDownloadName(filePath, response)}`);
      try {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(localPath, { flags: 'wx' }));
      } catch (error) {
        await rm(localPath, { force: true });
        throw error;
      }
      return cacheFile(key, localPath);
    })();

    pendingDownloads.set(key, download);
    try {
      return await download;
    } finally {
      pendingDownloads.delete(key);
    }
  };

  return {
    async prepare(webContents, serverUrl, requestValue) {
      const request = normalizeDesktopFileDragRequest(requestValue);
      if (!request) throw new Error('Invalid desktop file drag request.');
      return Promise.all(request.paths.map((filePath) => (
        downloadFile(webContents, serverUrl, request.workspaceId, filePath)
      )));
    },

    start(webContents, requestValue) {
      const request = normalizeDesktopFileDragRequest(requestValue);
      if (!request) return false;

      const localPaths = request.paths.map((filePath) => (
        cachedFiles.get(cacheKey(request.workspaceId, filePath))?.localPath
      ));
      if (localPaths.some((localPath) => !localPath)) return false;

      webContents.startDrag({ files: localPaths, icon: iconPath });
      return true;
    },

    async dispose() {
      const keys = Array.from(cachedFiles.keys());
      await Promise.all(keys.map((key) => removeCachedFile(key)));
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}
