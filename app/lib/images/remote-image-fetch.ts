import 'server-only';

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DEFAULT_REMOTE_IMAGE_TIMEOUT_MS = 12_000;
const MAX_REMOTE_IMAGE_REDIRECTS = 5;

type FetchRemoteImageBufferOptions = {
  maxBytes: number;
  requireImageMimeType?: boolean;
  timeoutMs?: number;
  tooLargeMessage?: string;
};

export type RemoteImageBuffer = {
  buffer: Buffer;
  finalUrl: URL;
  mimeType: string;
};

function normalizeRemoteHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isPrivateIPv4Address(hostname: string) {
  const octets = hostname.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }

  const [first, second] = octets;
  return (
    first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224
  );
}

function isPrivateIPv6Address(hostname: string) {
  const normalized = normalizeRemoteHostname(hostname);
  const mappedIPv4 = normalized.match(/(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (mappedIPv4) return isPrivateIPv4Address(mappedIPv4);

  if (normalized === '::' || normalized === '::1') return true;

  const firstHextet = Number.parseInt(normalized.split(':')[0] || '0', 16);
  if (!Number.isFinite(firstHextet)) return true;

  return (
    (firstHextet & 0xfe00) === 0xfc00
    || (firstHextet & 0xffc0) === 0xfe80
    || (firstHextet & 0xff00) === 0xff00
    || normalized.startsWith('2001:db8:')
  );
}

function isPrivateIpAddress(hostname: string) {
  const normalized = normalizeRemoteHostname(hostname);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isPrivateIPv4Address(normalized);
  if (ipVersion === 6) return isPrivateIPv6Address(normalized);
  return false;
}

async function assertRemoteImageUrlAllowed(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS image URLs can be imported.');
  }

  const hostname = normalizeRemoteHostname(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Image URL host is not allowed.');
  }

  if (isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) throw new Error('Image URL host is not allowed.');
    return;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error('Image URL host could not be resolved.');
  }

  if (addresses.length === 0 || addresses.some((entry) => isPrivateIpAddress(entry.address))) {
    throw new Error('Image URL host is not allowed.');
  }
}

async function readResponseBufferWithLimit(response: Response, limit: number, tooLargeMessage: string) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = Buffer.from(value);
    totalSize += chunk.length;
    if (totalSize > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(tooLargeMessage);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, totalSize);
}

async function fetchAllowedRemoteImage(url: URL, signal: AbortSignal) {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_REMOTE_IMAGE_REDIRECTS; redirectCount += 1) {
    await assertRemoteImageUrlAllowed(currentUrl);

    const response = await fetch(currentUrl, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      redirect: 'manual',
      signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Image URL redirect did not include a location.');
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    return { response, finalUrl: currentUrl };
  }

  throw new Error('Image URL redirected too many times.');
}

export async function fetchRemoteImageBuffer(
  rawUrl: string | URL,
  options: FetchRemoteImageBufferOptions,
): Promise<RemoteImageBuffer> {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    throw new Error('Invalid image URL.');
  }

  const tooLargeMessage = options.tooLargeMessage || 'Image URL is too large.';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_REMOTE_IMAGE_TIMEOUT_MS);

  try {
    const { response, finalUrl } = await fetchAllowedRemoteImage(url, controller.signal);
    if (!response.ok) {
      throw new Error(`Image URL responded with ${response.status}.`);
    }

    const contentLength = Number(response.headers.get('content-length') || '0');
    if (contentLength > options.maxBytes) {
      throw new Error(tooLargeMessage);
    }

    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
    if (options.requireImageMimeType && !mimeType.toLowerCase().startsWith('image/')) {
      throw new Error('URL does not point to an image.');
    }

    return {
      buffer: await readResponseBufferWithLimit(response, options.maxBytes, tooLargeMessage),
      finalUrl,
      mimeType,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Image URL request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
