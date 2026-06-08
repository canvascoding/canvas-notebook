type RequestOriginInput = {
  headers: Pick<Headers, 'get'>;
  url: string | URL;
};

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  return first || null;
}

function normalizeHost(value: string | null): string | null {
  const host = firstHeaderValue(value);
  if (!host || /[\s/@\\?#]/.test(host)) return null;
  return host;
}

function normalizeProtocol(value: string | null): 'http' | 'https' | null {
  const protocol = firstHeaderValue(value)?.replace(/:$/, '').toLowerCase();
  if (protocol === 'http' || protocol === 'https') return protocol;
  return null;
}

function originFromHost(protocol: 'http' | 'https', host: string): string | null {
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

export function getPublicRequestOrigin(request: RequestOriginInput): string {
  const url = new URL(String(request.url));
  const host = normalizeHost(request.headers.get('x-forwarded-host'))
    || normalizeHost(request.headers.get('host'));
  const protocol = normalizeProtocol(request.headers.get('x-forwarded-proto'))
    || normalizeProtocol(url.protocol)
    || 'http';

  if (host) {
    return originFromHost(protocol, host) || url.origin;
  }

  return url.origin;
}

export function normalizePublicOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function buildPublicRequestUrl(request: RequestOriginInput, relativePath: string): URL {
  return new URL(relativePath, getPublicRequestOrigin(request));
}
