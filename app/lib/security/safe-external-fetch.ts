import dns from 'node:dns/promises';
import net from 'node:net';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const ALLOWED_PORTS = new Set(['', '80', '443']);

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

function normalizeIpv6(ip: string): string {
  return ip.toLowerCase();
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = normalizeIpv6(ip);
  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff');
}

function assertPublicIp(address: string) {
  const family = net.isIP(address);
  if (family === 4 && isPrivateIpv4(address)) {
    throw new Error('Blocked private or local network address');
  }
  if (family === 6 && isPrivateIpv6(address)) {
    throw new Error('Blocked private or local network address');
  }
  if (family === 0) {
    throw new Error('Unresolvable network address');
  }
}

async function assertSafeUrl(url: URL) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http:// and https:// URLs are allowed');
  }
  if (url.username || url.password) {
    throw new Error('Credentials in URLs are not allowed');
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new Error('Only standard HTTP(S) ports are allowed');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Localhost URLs are not allowed');
  }

  if (net.isIP(hostname)) {
    assertPublicIp(hostname);
    return;
  }

  const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new Error('Could not resolve remote host');
  }
  for (const entry of resolved) {
    assertPublicIp(entry.address);
  }
}

export async function fetchExternalResourceSafely(
  rawUrl: string,
  options?: { maxBytes?: number; timeoutMs?: number }
) {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let currentUrl = new URL(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    await assertSafeUrl(currentUrl);

    const response = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
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
      throw new Error(`Failed to fetch resource: ${response.status} ${response.statusText}`);
    }

    const advertisedLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
      throw new Error(`Remote file exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > maxBytes) {
      throw new Error(`Remote file exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    }

    return {
      buffer,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      finalUrl: currentUrl.toString(),
    };
  }

  throw new Error('Too many redirects');
}
