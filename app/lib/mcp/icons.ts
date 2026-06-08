import crypto from 'crypto';
import path from 'path';

import { readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import {
  readSettingsBufferFileIfExists,
  readSettingsTextFileIfExists,
  writeSettingsBufferFileAtomic,
  writeSettingsTextFileAtomic,
} from '@/app/lib/settings-storage';

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

async function readIconCache(): Promise<McpIconCacheFile> {
  try {
    const { content } = await readSettingsTextFileIfExists(ICON_CACHE_FILE);
    if (!content) {
      return { version: 1, updatedAt: new Date(0).toISOString(), servers: {} };
    }
    return JSON.parse(content) as McpIconCacheFile;
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), servers: {} };
  }
}

async function writeIconCache(cache: McpIconCacheFile): Promise<void> {
  cache.updatedAt = new Date().toISOString();
  await writeSettingsTextFileAtomic(ICON_CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
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

async function fetchIcon(serverName: string, origin: string, iconUrl: string): Promise<McpServerIconMetadata> {
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

  const extension = CONTENT_TYPE_EXTENSIONS[contentType];
  const digest = crypto.createHash('sha256').update(`${serverName}:${iconUrl}:${buffer.length}`).digest('hex').slice(0, 16);
  const fileName = `${sanitizeServerName(serverName)}-${digest}.${extension}`;
  await writeSettingsBufferFileAtomic(path.join(ICON_CACHE_DIR, fileName), buffer);

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

export async function refreshMcpServerIcon(serverName: string, serverConfig: McpServerConfig): Promise<McpServerIconMetadata> {
  const origin = getServerOrigin(serverConfig);
  const configuredIconUrl = getConfiguredIconUrl(serverConfig);
  const cache = await readIconCache();

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
    await writeIconCache(cache);
    return metadata;
  }

  try {
    const candidates = await buildIconCandidates(serverConfig);
    let lastError = 'No icon candidates found.';
    for (const candidate of candidates) {
      try {
        const metadata = await fetchIcon(serverName, candidate.origin, candidate.iconUrl);
        cache.servers[serverName] = metadata;
        await writeIconCache(cache);
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
    await writeIconCache(cache);
    return metadata;
  }
}

export async function getMcpServerIconMetadata(serverName: string): Promise<McpServerIconMetadata | null> {
  const config = await readMcpConfig();
  const serverConfig = config.mcpServers[serverName];
  if (!serverConfig) return null;

  const cache = await readIconCache();
  const metadata = cache.servers[serverName];

  if (shouldRefreshIcon(metadata, serverConfig)) {
    return refreshMcpServerIcon(serverName, serverConfig);
  }

  return metadata || null;
}

export async function refreshMcpServerIcons(): Promise<Record<string, McpServerIconMetadata | null>> {
  const config = await readMcpConfig();
  const cache = await readIconCache();
  const result: Record<string, McpServerIconMetadata | null> = {};

  await Promise.all(Object.entries(config.mcpServers).map(async ([serverName, serverConfig]) => {
    const metadata = cache.servers[serverName];
    if (!shouldRefreshIcon(metadata, serverConfig)) {
      result[serverName] = metadata || null;
      return;
    }
    result[serverName] = await refreshMcpServerIcon(serverName, serverConfig).catch(() => null);
  }));

  return result;
}

export async function readMcpServerIconFile(serverName: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const metadata = await getMcpServerIconMetadata(serverName);
  if (!metadata?.fileName || !metadata.contentType) return null;

  const { buffer } = await readSettingsBufferFileIfExists(path.join(ICON_CACHE_DIR, metadata.fileName));
  if (!buffer) return null;
  return { buffer, contentType: metadata.contentType };
}
