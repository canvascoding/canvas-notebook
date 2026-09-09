import { lookup } from 'node:dns/promises';
import net from 'node:net';

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) {
    const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    const mapped = normalized.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/u);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    // Only global unicast; deny translation/tunnelling and documentation ranges.
    const [first, second] = normalized.split(':').map((part) => Number.parseInt(part || '0', 16));
    return first < 0x2000 || first > 0x3fff
      || (first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
      || first === 0x2002
      || (first === 0x3fff && second <= 0x0fff);
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
  return (await resolveMcpHttpTarget(rawUrl, purpose)).url;
}

/** Resolve once and use this exact address when opening the socket. */
export async function resolveMcpHttpTarget(rawUrl: string, purpose: string): Promise<{
  url: URL;
  address: string;
  family: 4 | 6;
}> {
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
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const privateAllowed = allowPrivateNetwork();
  if (!privateAllowed && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
    throw new Error(`${purpose} targets a blocked private network host.`);
  }
  if (net.isIP(hostname)) {
    if (!privateAllowed && isPrivateAddress(hostname)) throw new Error(`${purpose} targets a blocked private network address.`);
    return { url, address: hostname, family: net.isIP(hostname) as 4 | 6 };
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0 || (!privateAllowed && addresses.some((entry) => isPrivateAddress(entry.address)))) {
    throw new Error(`${purpose} targets a blocked or unresolved network host.`);
  }
  return { url, address: addresses[0].address, family: addresses[0].family as 4 | 6 };
}
