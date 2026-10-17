import crypto from 'crypto';
import path from 'path';
import { constants, promises as fs } from 'node:fs';

import { readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import { fetchMcpHttp } from '@/app/lib/mcp/http';
import {
  readMcpBufferFileIfExists,
  readMcpTextFileIfExists,
  writeMcpBufferFileAtomic,
  writeMcpTextFileAtomic,
  resolveMcpStoragePath,
} from '@/app/lib/mcp/storage';
import { getMcpScopeKey, type McpScope } from '@/app/lib/mcp/scope';
import { supportedImage } from '@/app/lib/capabilities/packages/package-icon-image';

const ICON_CACHE_FILE = 'mcp-server-icons.json';
const ICON_CACHE_DIR = 'mcp-icons';
const MAX_ICON_BYTES = 256 * 1024;
const ICON_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_ICON_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
const DISCOVERY_VERSION = 2;

type McpIconCacheFile = {
  version: 1;
  updatedAt: string;
  servers: Record<string, McpServerIconMetadata>;
};

export type McpServerIconMetadata = {
  serverName: string;
  origin: string | null;
  iconUrl: string | null;
  contentType: string | null;
  fileName: string | null;
  fetchedAt: string | null;
  discoveryVersion?: number;
  error?: string;
};

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function sanitizeServerName(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'server';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown MCP icon error';
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function getServerOrigin(serverConfig: McpServerConfig): string | null {
  if (typeof serverConfig.url !== 'string' || !serverConfig.url.trim()) return null;
  try {
    const url = new URL(serverConfig.url.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function getConfiguredIconUrl(serverConfig: McpServerConfig): string | null {
  if (typeof serverConfig.iconUrl !== 'string' || !serverConfig.iconUrl.trim()) return null;
  const iconUrl = serverConfig.iconUrl.trim();
  return isHttpUrl(iconUrl) ? iconUrl : null;
}

function isIpLikeHostname(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) || hostname.includes(':');
}

function getRegistrableOrigin(origin: string): string | null {
  const url = new URL(origin);
  const labels = url.hostname.split('.').filter(Boolean);
  if (labels.length <= 2 || url.hostname === 'localhost' || isIpLikeHostname(url.hostname)) {
    return null;
  }

  const secondLevelPublicSuffixes = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);
  const sliceCount = labels.length >= 3 && labels.at(-1)?.length === 2 && secondLevelPublicSuffixes.has(labels.at(-2) || '')
    ? 3
    : 2;
  const hostname = labels.slice(-sliceCount).join('.');
  const registrableOrigin = `${url.protocol}//${hostname}`;
  return registrableOrigin === origin ? null : registrableOrigin;
}

async function readIconCache(scope?: McpScope | null): Promise<McpIconCacheFile> {
  try {
    const { content } = await readMcpTextFileIfExists(ICON_CACHE_FILE, scope);
    if (!content) {
      return { version: 1, updatedAt: new Date(0).toISOString(), servers: {} };
    }
    return JSON.parse(content) as McpIconCacheFile;
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), servers: {} };
  }
}

async function writeIconCache(cache: McpIconCacheFile, scope?: McpScope | null): Promise<void> {
  cache.updatedAt = new Date().toISOString();
  await writeMcpTextFileAtomic(ICON_CACHE_FILE, JSON.stringify(cache, null, 2), scope);
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetchMcpHttp(url, init, {
    purpose: 'MCP icon URL',
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_ICON_BYTES,
  });
}

function normalizeContentType(response: Response): string | null {
  const raw = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || null;
  return raw && CONTENT_TYPE_EXTENSIONS[raw] ? raw : null;
}

async function readLimitedResponseBuffer(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') || '0');
  if (contentLength > MAX_ICON_BYTES) {
    throw new Error('MCP icon is too large.');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ICON_BYTES) {
    throw new Error('MCP icon is too large.');
  }
  return buffer;
}

function extractIconCandidates(origin: string, html: string): string[] {
  const candidates: Array<{ href: string; score: number }> = [];
  const linkPattern = /<link\b[^>]*>/giu;
  const relPattern = /\brel\s*=\s*["']([^"']+)["']/iu;
  const hrefPattern = /\bhref\s*=\s*["']([^"']+)["']/iu;

  for (const match of html.matchAll(linkPattern)) {
    const tag = match[0];
    const rel = tag.match(relPattern)?.[1]?.toLowerCase() || '';
    const href = tag.match(hrefPattern)?.[1];
    if (!href || !/(^|\s)(icon|shortcut icon|apple-touch-icon|mask-icon)(\s|$)/u.test(rel)) continue;
    try {
      const url = new URL(href, origin).toString();
      if (!isHttpUrl(url)) continue;
      const score = rel.includes('apple-touch-icon') ? 3 : rel.includes('icon') ? 2 : 1;
      candidates.push({ href: url, score });
    } catch {
      // Ignore invalid icon references from remote HTML.
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.href);
}

async function discoverIconCandidates(origin: string): Promise<string[]> {
  const candidates = [`${origin}/favicon.ico`];

  try {
    const response = await fetchWithTimeout(origin, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.toLowerCase().includes('text/html')) {
        const html = await response.text();
        candidates.unshift(...extractIconCandidates(origin, html).slice(0, 5));
      }
    }
  } catch {
    // favicon.ico remains the fallback candidate.
  }

  return Array.from(new Set(candidates));
}

async function buildIconCandidates(serverConfig: McpServerConfig): Promise<Array<{ origin: string; iconUrl: string }>> {
  const origin = getServerOrigin(serverConfig);
  const configuredIconUrl = getConfiguredIconUrl(serverConfig);
  const candidates: Array<{ origin: string; iconUrl: string }> = [];

  if (configuredIconUrl) {
    candidates.push({
      origin: origin || new URL(configuredIconUrl).origin,
      iconUrl: configuredIconUrl,
    });
  }

  const origins = origin ? [origin, getRegistrableOrigin(origin)].filter((value): value is string => Boolean(value)) : [];
  for (const currentOrigin of origins) {
    for (const iconUrl of await discoverIconCandidates(currentOrigin)) {
      candidates.push({ origin: currentOrigin, iconUrl });
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.iconUrl)) return false;
    seen.add(candidate.iconUrl);
    return true;
  });
}

async function fetchIcon(serverName: string, origin: string, iconUrl: string, scope?: McpScope | null,
  assertCurrent?: () => Promise<void>): Promise<McpServerIconMetadata> {
  const response = await fetchWithTimeout(iconUrl, {
    headers: { Accept: 'image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.8' },
  });
  if (!response.ok) {
    throw new Error(`MCP icon request returned status ${response.status}.`);
  }

  const contentType = normalizeContentType(response);
  if (!contentType) {
    throw new Error('MCP icon response has an unsupported content type.');
  }

  const buffer = await readLimitedResponseBuffer(response);
  if (buffer.length === 0) {
    throw new Error('MCP icon response is empty.');
  }
  if (!supportedMcpIconImage(buffer, contentType)) {
    throw new Error('MCP icon contains unsupported image content.');
  }
  await assertCurrent?.();

  const extension = CONTENT_TYPE_EXTENSIONS[contentType];
  const digest = crypto.createHash('sha256').update(`${serverName}:${iconUrl}:${buffer.length}`).digest('hex').slice(0, 16);
  const fileName = `${sanitizeServerName(serverName)}-${digest}.${extension}`;
  await writeMcpBufferFileAtomic(path.join(ICON_CACHE_DIR, fileName), buffer, scope);

  return {
    serverName,
    origin,
    iconUrl,
    contentType,
    fileName,
    fetchedAt: new Date().toISOString(),
    discoveryVersion: DISCOVERY_VERSION,
  };
}

function supportedMcpIconImage(bytes: Buffer, contentType: string): boolean {
  if (['image/x-icon', 'image/vnd.microsoft.icon'].includes(contentType)) {
    if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return false;
    const count = bytes.readUInt16LE(4);
    if (!count || count > 256 || bytes.length < 6 + count * 16) return false;
    for (let index = 0; index < count; index += 1) {
      const entry = 6 + index * 16, size = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12);
      if (!size || offset < 6 + count * 16 || offset + size > bytes.length) return false;
    }
    return true;
  }
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(contentType)
    && supportedImage(bytes, contentType);
}

type BoundMcpIconCache = { version: 1; binding: string; fetchedAt: number; metadata: McpServerIconMetadata | null };
const boundIconRequests = new Map<string, Promise<{ buffer: Buffer; contentType: string } | null>>();
class McpIconAuthorityFailure extends Error {
  constructor(readonly original: unknown) { super('The MCP image source changed.'); }
}

async function readBoundIconFile(relativePath: string, scope: McpScope, maxBytes: number): Promise<Buffer | null> {
  const target = resolveMcpStoragePath(relativePath, scope);
  let handle;
  try { handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== BigInt(1) || !before.size || before.size > BigInt(maxBytes)) return null;
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) return null;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || (await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) return null;
    const parent = await fs.lstat(path.dirname(target));
    if (!parent.isDirectory() || parent.isSymbolicLink()) return null;
    return bytes;
  } finally { await handle.close(); }
}

/** Lazy image IO only. Callers must recheck the exact current human/source before and after IO. */
export async function readSourceBoundMcpServerIcon(serverConfig: McpServerConfig, binding: string,
  scope: McpScope, assertCurrent: () => Promise<void>, recoverJoiner = true): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!/^[a-f0-9]{64}$/u.test(binding)) throw new Error('Invalid MCP icon source binding.');
  await assertCurrent();
  const key = `${getMcpScopeKey(scope)}:${binding}`;
  let pending = boundIconRequests.get(key);
  const joined = Boolean(pending);
  if (!pending) {
    const guarded = async () => {
      try { await assertCurrent(); }
      catch (error) { throw new McpIconAuthorityFailure(error); }
    };
    pending = (async () => {
      const cachePath = path.join(ICON_CACHE_DIR, `bound-${binding}.json`);
      const readMetadata = await readBoundIconFile(cachePath, scope, 16 * 1024);
      await guarded();
      let cached: BoundMcpIconCache | undefined;
      if (readMetadata) {
        try { cached = JSON.parse(readMetadata.toString('utf8')) as BoundMcpIconCache; }
        catch { /* Invalid optional cache metadata is rediscovered. */ }
      }
      if (cached?.version === 1 && cached.binding === binding && Number.isFinite(cached.fetchedAt)
        && cached.fetchedAt > 0 && cached.fetchedAt <= Date.now()
        && Date.now() - cached.fetchedAt < (cached.metadata ? ICON_TTL_MS : NEGATIVE_ICON_TTL_MS)) {
        if (!cached.metadata) return null;
        const { fileName, contentType } = cached.metadata;
        const origin = getServerOrigin(serverConfig), configuredIcon = getConfiguredIconUrl(serverConfig);
        const allowedOrigins = new Set([origin, origin ? getRegistrableOrigin(origin) : null,
          !origin && configuredIcon ? new URL(configuredIcon).origin : null].filter(Boolean));
        if (cached.metadata.serverName === `bound-${binding}` && cached.metadata.discoveryVersion === DISCOVERY_VERSION
          && cached.metadata.origin && allowedOrigins.has(cached.metadata.origin)
          && fileName && new RegExp(`^bound-${binding}-[a-f0-9]{16}\\.(?:ico|png|jpg|svg|webp|gif)$`, 'u').test(fileName)
          && contentType && CONTENT_TYPE_EXTENSIONS[contentType]) {
          const buffer = await readBoundIconFile(path.join(ICON_CACHE_DIR, fileName), scope, MAX_ICON_BYTES);
          await guarded();
          if (buffer && supportedMcpIconImage(buffer, contentType)) return { buffer, contentType };
        }
      }
      // Domain discovery uses the endpoint's origin only, never MCP query credentials or headers.
      const configuredIconUrl = getConfiguredIconUrl(serverConfig);
      let iconUrl: string | undefined;
      if (configuredIconUrl) {
        const configured = new URL(configuredIconUrl);
        if (!configured.username && !configured.password) {
          configured.search = ''; configured.hash = ''; iconUrl = configured.href;
        }
      }
      const origin = getServerOrigin(serverConfig);
      const candidates = await buildIconCandidates({ ...(origin ? { url: origin } : {}), ...(iconUrl ? { iconUrl } : {}) });
      await guarded();
      let metadata: McpServerIconMetadata | null = null;
      for (const candidate of candidates) {
        await guarded();
        try { metadata = await fetchIcon(`bound-${binding}`, candidate.origin, candidate.iconUrl, scope, guarded); break; }
        catch (error) { if (error instanceof McpIconAuthorityFailure) throw error; }
      }
      await guarded();
      await writeMcpTextFileAtomic(cachePath, JSON.stringify({ version: 1, binding, fetchedAt: Date.now(), metadata } satisfies BoundMcpIconCache), scope);
      await guarded();
      if (!metadata?.fileName || !metadata.contentType) return null;
      const buffer = await readBoundIconFile(path.join(ICON_CACHE_DIR, metadata.fileName), scope, MAX_ICON_BYTES);
      await guarded();
      return buffer && supportedMcpIconImage(buffer, metadata.contentType) ? { buffer, contentType: metadata.contentType } : null;
    })();
    boundIconRequests.set(key, pending);
    void pending.finally(() => { if (boundIconRequests.get(key) === pending) boundIconRequests.delete(key); }).catch(() => undefined);
  }
  try {
    const image = await pending;
    await assertCurrent();
    return image;
  } catch (error) {
    if (!(error instanceof McpIconAuthorityFailure)) throw error;
    if (joined && recoverJoiner) {
      // A coalesced caller owns its own request/workspace authority. An aborted
      // first owner cannot force a still-authorized viewer onto initials.
      await assertCurrent();
      if (boundIconRequests.get(key) === pending) boundIconRequests.delete(key);
      return readSourceBoundMcpServerIcon(serverConfig, binding, scope, assertCurrent, false);
    }
    throw error.original;
  }
}

function shouldRefreshIcon(metadata: McpServerIconMetadata | undefined, serverConfig: McpServerConfig): boolean {
  const origin = getServerOrigin(serverConfig);
  const configuredIconUrl = getConfiguredIconUrl(serverConfig);
  const allowedOrigins = new Set([origin, origin ? getRegistrableOrigin(origin) : null].filter(Boolean));
  if (!origin && !configuredIconUrl) return false;
  if (metadata?.discoveryVersion !== DISCOVERY_VERSION) return true;
  if (!metadata) return true;
  if (configuredIconUrl && metadata.iconUrl !== configuredIconUrl && !metadata.fileName) return true;
  if (origin && metadata.origin && !allowedOrigins.has(metadata.origin)) return true;
  if (!metadata.fetchedAt) return true;
  const ttl = metadata.fileName ? ICON_TTL_MS : NEGATIVE_ICON_TTL_MS;
  return Date.now() - Date.parse(metadata.fetchedAt) > ttl;
}

export async function refreshMcpServerIcon(serverName: string, serverConfig: McpServerConfig, scope?: McpScope | null): Promise<McpServerIconMetadata> {
  const origin = getServerOrigin(serverConfig);
  const configuredIconUrl = getConfiguredIconUrl(serverConfig);
  const cache = await readIconCache(scope);

  if (!origin && !configuredIconUrl) {
    const metadata: McpServerIconMetadata = {
      serverName,
      origin: null,
      iconUrl: null,
      contentType: null,
      fileName: null,
      fetchedAt: new Date().toISOString(),
      discoveryVersion: DISCOVERY_VERSION,
      error: 'MCP server has no HTTP origin.',
    };
    cache.servers[serverName] = metadata;
    await writeIconCache(cache, scope);
    return metadata;
  }

  try {
    const candidates = await buildIconCandidates(serverConfig);
    let lastError = 'No icon candidates found.';
    for (const candidate of candidates) {
      try {
        const metadata = await fetchIcon(serverName, candidate.origin, candidate.iconUrl, scope);
        cache.servers[serverName] = metadata;
        await writeIconCache(cache, scope);
        return metadata;
      } catch (error) {
        lastError = getErrorMessage(error);
      }
    }
    throw new Error(lastError);
  } catch (error) {
    const metadata: McpServerIconMetadata = {
      serverName,
      origin,
      iconUrl: null,
      contentType: null,
      fileName: null,
      fetchedAt: new Date().toISOString(),
      discoveryVersion: DISCOVERY_VERSION,
      error: getErrorMessage(error),
    };
    cache.servers[serverName] = metadata;
    await writeIconCache(cache, scope);
    return metadata;
  }
}

export async function getMcpServerIconMetadata(serverName: string, scope?: McpScope | null): Promise<McpServerIconMetadata | null> {
  const config = await readMcpConfig(scope);
  const serverConfig = config.mcpServers[serverName];
  if (!serverConfig) return null;

  const cache = await readIconCache(scope);
  const metadata = cache.servers[serverName];

  if (shouldRefreshIcon(metadata, serverConfig)) {
    return refreshMcpServerIcon(serverName, serverConfig, scope);
  }

  return metadata || null;
}

export async function readCachedMcpServerIcons(scope?: McpScope | null): Promise<Record<string, McpServerIconMetadata>> {
  return (await readIconCache(scope)).servers;
}

export async function refreshMcpServerIcons(scope?: McpScope | null): Promise<Record<string, McpServerIconMetadata | null>> {
  const config = await readMcpConfig(scope);
  const cache = await readIconCache(scope);
  const result: Record<string, McpServerIconMetadata | null> = {};

  await Promise.all(Object.entries(config.mcpServers).map(async ([serverName, serverConfig]) => {
    const metadata = cache.servers[serverName];
    if (!shouldRefreshIcon(metadata, serverConfig)) {
      result[serverName] = metadata || null;
      return;
    }
    result[serverName] = await refreshMcpServerIcon(serverName, serverConfig, scope).catch(() => null);
  }));

  return result;
}

export async function readMcpServerIconFile(serverName: string, scope?: McpScope | null): Promise<{ buffer: Buffer; contentType: string } | null> {
  const metadata = await getMcpServerIconMetadata(serverName, scope);
  if (!metadata?.fileName || !metadata.contentType) return null;

  const { buffer } = await readMcpBufferFileIfExists(path.join(ICON_CACHE_DIR, metadata.fileName), scope);
  if (!buffer) return null;
  return { buffer, contentType: metadata.contentType };
}
