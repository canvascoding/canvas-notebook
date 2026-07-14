import dns from 'node:dns/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const ALLOWED_PORTS = new Set(['', '80', '443']);

type PublicNetworkAddress = {
  address: string;
  family: 4 | 6;
};

export type PublicHttpRequestOptions = {
  headers?: Record<string, string>;
  method?: string;
  signal?: AbortSignal;
  timeoutMs: number;
};

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  const ranges: Array<[number, number]> = [
    [ipv4ToInt('0.0.0.0'), ipv4ToInt('0.255.255.255')],
    [ipv4ToInt('10.0.0.0'), ipv4ToInt('10.255.255.255')],
    [ipv4ToInt('100.64.0.0'), ipv4ToInt('100.127.255.255')],
    [ipv4ToInt('127.0.0.0'), ipv4ToInt('127.255.255.255')],
    [ipv4ToInt('169.254.0.0'), ipv4ToInt('169.254.255.255')],
    [ipv4ToInt('172.16.0.0'), ipv4ToInt('172.31.255.255')],
    [ipv4ToInt('192.0.0.0'), ipv4ToInt('192.0.0.255')],
    [ipv4ToInt('192.0.2.0'), ipv4ToInt('192.0.2.255')],
    [ipv4ToInt('192.168.0.0'), ipv4ToInt('192.168.255.255')],
    [ipv4ToInt('198.18.0.0'), ipv4ToInt('198.19.255.255')],
    [ipv4ToInt('198.51.100.0'), ipv4ToInt('198.51.100.255')],
    [ipv4ToInt('203.0.113.0'), ipv4ToInt('203.0.113.255')],
    [ipv4ToInt('224.0.0.0'), ipv4ToInt('255.255.255.255')],
  ];
  return ranges.some(([start, end]) => value >= start && value <= end);
}

function normalizeIp(address: string): string {
  return address.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase();
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = normalizeIp(ip);
  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);

  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('::ffff:')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:');
}

function assertPublicIp(address: string): PublicNetworkAddress {
  const normalized = normalizeIp(address);
  const family = net.isIP(normalized);
  if (family === 4 && !isPrivateIpv4(normalized)) {
    return { address: normalized, family };
  }
  if (family === 6 && !isPrivateIpv6(normalized)) {
    return { address: normalized, family };
  }
  if (family === 0) {
    throw new Error('Unresolvable network address');
  }
  throw new Error('Blocked private or local network address');
}

function assertSafeUrlShape(url: URL): string {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http:// and https:// URLs are allowed');
  }
  if (url.username || url.password) {
    throw new Error('Credentials in URLs are not allowed');
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new Error('Only standard HTTP(S) ports are allowed');
  }

  const hostname = normalizeIp(url.hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Localhost URLs are not allowed');
  }
  return hostname;
}

async function resolvePublicNetworkAddress(url: URL): Promise<PublicNetworkAddress> {
  const hostname = assertSafeUrlShape(url);
  if (net.isIP(hostname)) {
    return assertPublicIp(hostname);
  }

  const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new Error('Could not resolve remote host');
  }

  const publicAddresses = resolved.map((entry) => assertPublicIp(entry.address));
  return publicAddresses[0];
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) result.append(name, entry);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

export async function requestPublicHttpUrl(url: URL, options: PublicHttpRequestOptions): Promise<Response> {
  const target = await resolvePublicNetworkAddress(url);
  const headers = new Headers(options.headers);
  headers.set('host', url.host);

  return new Promise<Response>((resolve, reject) => {
    const requestOptions = {
      protocol: url.protocol,
      hostname: target.address,
      family: target.family,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: Object.fromEntries(headers),
      servername: url.protocol === 'https:' ? normalizeIp(url.hostname) : undefined,
      signal: options.signal,
    };
    const send = url.protocol === 'https:' ? https.request : http.request;
    const request = send(requestOptions, (response) => {
      const status = response.statusCode && response.statusCode >= 200 && response.statusCode <= 599
        ? response.statusCode
        : 502;
      const body = status === 204 || status === 304
        ? null
        : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      resolve(new Response(body, {
        status,
        statusText: response.statusMessage || '',
        headers: responseHeaders(response.headers),
      }));
    });

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error('Remote request timed out'));
    });
    request.once('error', reject);
    request.end();
  });
}

export async function fetchExternalResourceSafely(
  rawUrl: string,
  options?: { maxBytes?: number; timeoutMs?: number }
) {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let currentUrl = new URL(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await requestPublicHttpUrl(currentUrl, {
      timeoutMs,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new Error('Redirect response missing location header');
      }
      if (redirectCount === MAX_REDIRECTS) {
        throw new Error('Too many redirects');
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new Error('Failed to fetch resource: ' + response.status + ' ' + response.statusText);
    }

    const advertisedLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
      throw new Error('Remote file exceeds ' + Math.round(maxBytes / (1024 * 1024)) + 'MB limit');
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > maxBytes) {
      throw new Error('Remote file exceeds ' + Math.round(maxBytes / (1024 * 1024)) + 'MB limit');
    }

    return {
      buffer,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      finalUrl: currentUrl.toString(),
    };
  }

  throw new Error('Too many redirects');
}
