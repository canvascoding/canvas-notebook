import { lookup } from 'node:dns/promises';
import net from 'node:net';

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1'
      || normalized === '::'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80:')
      || normalized.startsWith('::ffff:127.');
  }
  return true;
}

function allowPrivateNetwork(): boolean {
  return process.env.MCP_ALLOW_PRIVATE_NETWORK === 'true' || process.env.NODE_ENV !== 'production';
}

function allowInsecureHttp(): boolean {
  return process.env.MCP_ALLOW_INSECURE_HTTP === 'true' || process.env.NODE_ENV !== 'production';
}

export async function assertMcpHttpUrlAllowed(rawUrl: string, purpose: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${purpose} must be a valid HTTP(S) URL.`);
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error(`${purpose} must use HTTP(S).`);
  }
  if (url.username || url.password) {
    throw new Error(`${purpose} must not contain embedded credentials.`);
  }
  if (url.protocol !== 'https:' && !allowInsecureHttp()) {
    throw new Error(`${purpose} must use HTTPS in production.`);
  }
  if (allowPrivateNetwork()) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error(`${purpose} targets a blocked private network host.`);
  }
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error(`${purpose} targets a blocked private network address.`);
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error(`${purpose} targets a blocked or unresolved network host.`);
  }
  return url;
}
