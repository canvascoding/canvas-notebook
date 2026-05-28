const HEALTH_PATH = '/api/health';
const DEFAULT_TIMEOUT_MS = 8000;

function hasProtocol(value) {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname.startsWith('127.') || hostname === '::1' || hostname === '[::1]';
}

function withDefaultProtocol(value) {
  if (hasProtocol(value)) return value;

  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(value)) {
    return `http://${value}`;
  }

  return `https://${value}`;
}

export function normalizeServerUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';

  if (!raw) {
    throw new Error('Enter the URL of your Canvas Notebook server.');
  }

  const withProtocol = withDefaultProtocol(raw);
  let parsed;

  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error('Enter a valid server URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The server URL must start with http:// or https://.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Do not include usernames or passwords in the server URL.');
  }

  parsed.hash = '';
  parsed.search = '';

  const pathname = parsed.pathname.replace(/\/+$/, '');
  const basePath = pathname === '/' ? '' : pathname;
  const normalized = `${parsed.origin}${basePath}`;
  const warning = parsed.protocol === 'http:' && !isLocalHost(parsed.hostname)
    ? 'HTTP is only recommended for local development or trusted private networks.'
    : null;

  return { serverUrl: normalized, warning };
}

export function buildServerPath(serverUrl, pathname) {
  return `${serverUrl.replace(/\/+$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

export async function checkServerHealth(rawServerUrl, options = {}) {
  let normalized;

  try {
    normalized = normalizeServerUrl(rawServerUrl);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Invalid server URL.',
    };
  }

  const healthUrl = buildServerPath(normalized.serverUrl, HEALTH_PATH);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(healthUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        serverUrl: normalized.serverUrl,
        status: response.status,
        message: `Health check failed with HTTP ${response.status}.`,
        body,
        warning: normalized.warning,
      };
    }

    return {
      ok: true,
      serverUrl: normalized.serverUrl,
      status: response.status,
      body,
      warning: normalized.warning,
    };
  } catch (error) {
    const aborted = error?.name === 'AbortError';

    return {
      ok: false,
      serverUrl: normalized.serverUrl,
      message: aborted
        ? `Health check timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        : `Could not reach ${healthUrl}.`,
      detail: error instanceof Error ? error.message : String(error),
      warning: normalized.warning,
    };
  } finally {
    clearTimeout(timeout);
  }
}
