import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

import { isTrustedProxyIdentity } from './proxy-identity';

type RequestIdentity = { clientAddress: string; verifiedUserId: string | null };

// The custom server and Next's compiled route modules share the same store.
// No identity is accepted from request cookies or a client-supplied user header.
const runtime = globalThis as typeof globalThis & {
  __canvasRequestIdentity?: AsyncLocalStorage<RequestIdentity>;
};

function identityStore(): AsyncLocalStorage<RequestIdentity> {
  return runtime.__canvasRequestIdentity ??= new AsyncLocalStorage<RequestIdentity>();
}

export function normalizeClientAddress(value: string | undefined): string | null {
  if (!value || value.length > 64 || !isIP(value)) return null;
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  if (isIP(value) === 6) {
    // Canonicalize equivalent IPv6 spellings before deriving an abuse bucket.
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  }
  return value;
}

export function resolveRequestClientAddress(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
  internalApiKey = process.env.CANVAS_INTERNAL_API_KEY,
): string {
  const proxyToken = request.headers['x-canvas-proxy-token'];
  const proxyAddress = request.headers['x-canvas-proxy-client-ip'];
  if (typeof proxyToken === 'string' && typeof proxyAddress === 'string'
      && isTrustedProxyIdentity(proxyToken, internalApiKey)) {
    const normalized = normalizeClientAddress(proxyAddress);
    if (normalized) return normalized;
  }
  return normalizeClientAddress(request.socket.remoteAddress) ?? 'unknown';
}

export function runWithRequestIdentity<T>(request: IncomingMessage, run: () => T): T {
  const clientAddress = resolveRequestClientAddress(request);
  // Strip the proxy credential before routing/logging. Overwrite IP headers so
  // the auth provider also receives the transport-verified client address.
  delete request.headers['x-canvas-proxy-token'];
  delete request.headers['x-canvas-proxy-client-ip'];
  request.headers['x-forwarded-for'] = clientAddress;
  request.headers['x-real-ip'] = clientAddress;
  return identityStore().run({ clientAddress, verifiedUserId: null }, run);
}

/** Called only after Better Auth and the seat-access guard have succeeded. */
export function rememberVerifiedRateLimitUser(userId: string | null): void {
  const identity = identityStore().getStore();
  if (identity) identity.verifiedUserId = userId;
}

export function getRequestRateLimitIdentity(): Readonly<RequestIdentity> | undefined {
  return identityStore().getStore();
}
