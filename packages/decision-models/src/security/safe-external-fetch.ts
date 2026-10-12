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

  // Only ordinary global unicast is eligible. Translation/tunnelling ranges
  // (NAT64, Teredo, 6to4) could otherwise encode an internal IPv4 destination.
  const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
  const [first, second] = canonical.split(':').map(part => Number.parseInt(part || '0', 16));
  return first < 0x2000 || first > 0x3fff
    || (first === 0x2001 && second <= 0x1ff)
    || (first === 0x2001 && second === 0xdb8)
    || first === 0x2002
    || (first === 0x3fff && second <= 0x0fff);
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

export async function resolvePublicNetworkAddress(url: URL): Promise<PublicNetworkAddress> {
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
  const target = await withRequestAbort(resolvePublicNetworkAddress(url), options.signal);
  options.signal?.throwIfAborted();
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
  options?: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal }
) {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Fetch byte and time limits must be positive integers.');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let currentUrl = new URL(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await requestPublicHttpUrl(currentUrl, {
      timeoutMs,
      signal,
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
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Failed to fetch resource: ' + response.status + ' ' + response.statusText);
    }

    const advertisedLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Remote file exceeds ' + Math.round(maxBytes / (1024 * 1024)) + 'MB limit');
    }

    const buffer = await readBoundedResponseBody(response, maxBytes, signal);

    return {
      buffer,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      finalUrl: currentUrl.toString(),
      statusCode: response.status,
    };
  }

  throw new Error('Too many redirects');
}

function withRequestAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Request aborted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Enforce the byte ceiling before buffering an untrusted complete response. */
export async function readBoundedResponseBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Fetch byte limit must be a positive integer.');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await withRequestAbort(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error(`Remote file exceeds ${maxBytes}-byte limit`);
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    // Do not wait for a peer that never finishes its stream cancellation.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
