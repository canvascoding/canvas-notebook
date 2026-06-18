import 'server-only';

import dns from 'node:dns/promises';
import net from 'node:net';

const HTML_BYTE_LIMIT = 512 * 1024;
const LINK_PREVIEW_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;
const FETCH_USER_AGENT = 'Canvas Notebook Link Preview/1.0';

const OG_IMAGE_KEYS = new Set([
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:image',
  'twitter:image:src',
]);

export type MarkdownLinkPreviewResult = {
  url: string;
  normalizedUrl: string;
  host: string;
  imageUrl: string | null;
};

export class MarkdownLinkPreviewError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'MarkdownLinkPreviewError';
  }
}

export async function loadMarkdownLinkPreview(inputUrl: string): Promise<MarkdownLinkPreviewResult> {
  const targetUrl = parseRemoteHttpUrl(inputUrl);
  await assertSafeRemoteUrl(targetUrl);

  let response: Awaited<ReturnType<typeof fetchWithValidatedRedirects>>;
  try {
    response = await fetchWithValidatedRedirects(targetUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': FETCH_USER_AGENT,
      },
    });
  } catch (error) {
    const providerImageUrl = await resolveProviderPreviewImageUrl(targetUrl);
    if (providerImageUrl) return buildPreviewResult(targetUrl, providerImageUrl);
    throw error;
  }

  if (!response.response.ok) {
    const providerImageUrl = await resolveProviderPreviewImageUrl(response.url);
    if (providerImageUrl) return buildPreviewResult(response.url, providerImageUrl);
    throw new MarkdownLinkPreviewError('Could not load link metadata', 502);
  }

  const contentType = response.response.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    const providerImageUrl = await resolveProviderPreviewImageUrl(response.url);
    return buildPreviewResult(response.url, providerImageUrl);
  }

  const html = await readMetadataHtml(response.response, HTML_BYTE_LIMIT);
  const imageUrl = await resolvePreviewImageUrl(html, response.url);

  return buildPreviewResult(response.url, imageUrl);
}

function buildPreviewResult(url: URL, imageUrl: string | null): MarkdownLinkPreviewResult {
  return {
    url: url.toString(),
    normalizedUrl: url.toString(),
    host: url.hostname,
    imageUrl,
  };
}

function parseRemoteHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new MarkdownLinkPreviewError('Enter a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MarkdownLinkPreviewError('Only http and https URLs are supported');
  }

  if (url.username || url.password) {
    throw new MarkdownLinkPreviewError('URLs with credentials are not supported');
  }

  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new MarkdownLinkPreviewError('URLs with custom ports are not supported');
  }

  return url;
}

async function assertSafeRemoteUrl(url: URL) {
  const hostname = normalizeHostname(url.hostname);

  if (!hostname || isBlockedHostname(hostname)) {
    throw new MarkdownLinkPreviewError('This host is not available for link previews');
  }

  const literalIpVersion = net.isIP(hostname);
  if (literalIpVersion) {
    if (isBlockedIp(hostname)) {
      throw new MarkdownLinkPreviewError('This host is not available for link previews');
    }
    return;
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: false });
  } catch {
    throw new MarkdownLinkPreviewError('Could not resolve link host', 400);
  }

  if (records.length === 0 || records.some((record) => isBlockedIp(record.address))) {
    throw new MarkdownLinkPreviewError('This host is not available for link previews');
  }
}

async function fetchWithValidatedRedirects(inputUrl: URL, init: RequestInit) {
  let currentUrl = inputUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertSafeRemoteUrl(currentUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LINK_PREVIEW_TIMEOUT_MS);
    try {
      const response = await fetch(currentUrl, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new MarkdownLinkPreviewError('Link preview redirect is missing a destination', 502);
        }
        currentUrl = parseRemoteHttpUrl(new URL(location, currentUrl).toString());
        continue;
      }

      return { response, url: currentUrl };
    } catch (error) {
      if (error instanceof MarkdownLinkPreviewError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new MarkdownLinkPreviewError('Link preview request timed out', 504);
      }
      throw new MarkdownLinkPreviewError('Could not load link preview', 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new MarkdownLinkPreviewError('Link preview followed too many redirects', 502);
}

async function resolvePreviewImageUrl(html: string, baseUrl: URL) {
  const rawImageUrl = extractOgImageUrl(html);
  if (!rawImageUrl) return resolveProviderPreviewImageUrl(baseUrl);

  let imageUrl: URL;
  try {
    imageUrl = parseRemoteHttpUrl(new URL(rawImageUrl, baseUrl).toString());
  } catch {
    return resolveProviderPreviewImageUrl(baseUrl);
  }

  try {
    await assertSafeRemoteUrl(imageUrl);
    const valid = await validateRemoteImage(imageUrl);
    if (valid) return imageUrl.toString();
  } catch {
    return resolveProviderPreviewImageUrl(baseUrl);
  }

  return resolveProviderPreviewImageUrl(baseUrl);
}

function extractOgImageUrl(html: string) {
  const metaTags = html.match(/<meta\b[^>]*>/giu) || [];
  for (const tag of metaTags) {
    const key = (getHtmlAttribute(tag, 'property') || getHtmlAttribute(tag, 'name') || '').toLowerCase();
    if (!OG_IMAGE_KEYS.has(key)) continue;

    const content = getHtmlAttribute(tag, 'content');
    if (content) return decodeHtmlAttribute(content);
  }

  return null;
}

function getHtmlAttribute(tag: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\b${escapedName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'iu'));
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

async function validateRemoteImage(imageUrl: URL) {
  const headResponse = await fetchWithValidatedRedirects(imageUrl, {
    method: 'HEAD',
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'User-Agent': FETCH_USER_AGENT,
    },
  });

  if (isImageResponse(headResponse.response)) return true;

  if (headResponse.response.status !== 405 && headResponse.response.status !== 403) {
    return false;
  }

  const getResponse = await fetchWithValidatedRedirects(imageUrl, {
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      Range: 'bytes=0-0',
      'User-Agent': FETCH_USER_AGENT,
    },
  });

  getResponse.response.body?.cancel().catch(() => undefined);
  return isImageResponse(getResponse.response);
}

function isImageResponse(response: Response) {
  if (!response.ok && response.status !== 206) return false;
  return (response.headers.get('content-type') || '').toLowerCase().startsWith('image/');
}

async function readMetadataHtml(response: Response, byteLimit: number) {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remainingBytes = byteLimit - totalBytes;
      if (remainingBytes <= 0) {
        await reader.cancel();
        break;
      }

      const chunk = value.byteLength > remainingBytes ? value.slice(0, remainingBytes) : value;
      totalBytes += chunk.byteLength;
      html += decoder.decode(chunk, { stream: true });

      const lowerHtml = html.toLowerCase();
      if (lowerHtml.includes('</head>') || extractOgImageUrl(html)) {
        await reader.cancel();
        break;
      }

      if (value.byteLength > remainingBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return html + decoder.decode();
}

async function resolveProviderPreviewImageUrl(url: URL) {
  const youtubeVideoId = extractYoutubeVideoId(url);
  if (!youtubeVideoId) return null;

  const candidates = [
    `https://img.youtube.com/vi/${youtubeVideoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${youtubeVideoId}/hqdefault.jpg`,
  ];

  for (const candidate of candidates) {
    try {
      const imageUrl = parseRemoteHttpUrl(candidate);
      await assertSafeRemoteUrl(imageUrl);
      if (await validateRemoteImage(imageUrl)) {
        return imageUrl.toString();
      }
    } catch {
      // Try the next provider-specific thumbnail candidate.
    }
  }

  return null;
}

function extractYoutubeVideoId(url: URL) {
  const hostname = normalizeHostname(url.hostname).replace(/^www\./u, '');
  const pathParts = url.pathname.split('/').filter(Boolean);
  let candidate: string | null = null;

  if (hostname === 'youtu.be') {
    candidate = pathParts[0] ?? null;
  } else if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
    if (url.pathname === '/watch') {
      candidate = url.searchParams.get('v');
    } else if (pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'live') {
      candidate = pathParts[1] ?? null;
    }
  }

  const normalized = candidate?.match(/^[A-Za-z0-9_-]{11}$/u)?.[0] ?? null;
  return normalized;
}

function normalizeHostname(hostname: string) {
  return hostname.replace(/^\[/u, '').replace(/\]$/u, '').replace(/\.$/u, '').toLowerCase();
}

function isBlockedHostname(hostname: string) {
  return (
    hostname === 'localhost' ||
    hostname === 'localhost.localdomain' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  );
}

function isBlockedIp(address: string) {
  const normalized = normalizeHostname(address);
  const version = net.isIP(normalized);
  if (version === 4) return isBlockedIpv4(normalized);
  if (version === 6) return isBlockedIpv6(normalized);
  return true;
}

function isBlockedIpv4(address: string) {
  return (
    ipv4InRange(address, '0.0.0.0', 8) ||
    ipv4InRange(address, '10.0.0.0', 8) ||
    ipv4InRange(address, '100.64.0.0', 10) ||
    ipv4InRange(address, '127.0.0.0', 8) ||
    ipv4InRange(address, '169.254.0.0', 16) ||
    ipv4InRange(address, '172.16.0.0', 12) ||
    ipv4InRange(address, '192.0.0.0', 24) ||
    ipv4InRange(address, '192.0.2.0', 24) ||
    ipv4InRange(address, '192.168.0.0', 16) ||
    ipv4InRange(address, '198.18.0.0', 15) ||
    ipv4InRange(address, '198.51.100.0', 24) ||
    ipv4InRange(address, '203.0.113.0', 24) ||
    ipv4InRange(address, '224.0.0.0', 4) ||
    ipv4InRange(address, '240.0.0.0', 4)
  );
}

function isBlockedIpv6(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;

  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);

  return (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  );
}

function ipv4InRange(address: string, baseAddress: string, maskBits: number) {
  const addressNumber = ipv4ToNumber(address);
  const baseNumber = ipv4ToNumber(baseAddress);
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (addressNumber & mask) === (baseNumber & mask);
}

function ipv4ToNumber(address: string) {
  return address.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}
