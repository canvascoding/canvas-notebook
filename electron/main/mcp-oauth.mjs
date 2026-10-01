const DESKTOP_STATE = /^desktop_[A-Za-z0-9_-]{32}$/u;
const MAX_AUTHORIZATION_URL_LENGTH = 16_384;

function safeWebUrl(value, allowLoopbackHttp) {
  if (typeof value !== 'string' || value.length > MAX_AUTHORIZATION_URL_LENGTH
    || value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
      || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:'
      && !(allowLoopbackHttp && loopback && url.protocol === 'http:'))) return null;
    return url;
  } catch { return null; }
}

function trustedMainFrame(event, browserWindow, origin) {
  if (!browserWindow || browserWindow.isDestroyed() || browserWindow.webContents.isDestroyed()) return false;
  if (event.sender !== browserWindow.webContents || event.senderFrame !== browserWindow.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
}

/** Open only the authorization URL stored for this authenticated desktop transaction. */
export function createMcpOAuthLauncher({ getMainWindow, getConfiguredServerUrl, openExternal, allowLoopbackHttp = false }) {
  return async (event, request) => {
    const configuredServerUrl = getConfiguredServerUrl();
    const serverUrl = safeWebUrl(configuredServerUrl, allowLoopbackHttp);
    const browserWindow = getMainWindow();
    if (!serverUrl || !trustedMainFrame(event, browserWindow, serverUrl.origin)) {
      return { ok: false, error: 'OAuth can only be opened from the configured Canvas Notebook window.' };
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || typeof request.state !== 'string' || !DESKTOP_STATE.test(request.state)
      || !safeWebUrl(request.authorizationUrl, allowLoopbackHttp)) {
      return { ok: false, error: 'The OAuth request is invalid. Start the connection again.' };
    }

    const transactionUrl = new URL('/api/mcp/oauth/desktop', serverUrl.origin);
    transactionUrl.searchParams.set('state', request.state);
    let response;
    try {
      response = await browserWindow.webContents.session.fetch(transactionUrl.href, {
        method: 'GET', credentials: 'include', redirect: 'error',
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || response.redirected) throw new Error('Transaction unavailable.');
      const body = await response.json();
      if (body?.success !== true || body.data?.status !== 'waiting'
        || body.data.authorizationUrl !== request.authorizationUrl) {
        return { ok: false, error: 'This OAuth request is no longer available. Start the connection again.' };
      }
    } catch {
      return { ok: false, error: 'Canvas could not verify the OAuth request. Retry the connection.' };
    }

    // The renderer may navigate or the configured server may change during the request.
    if (getMainWindow() !== browserWindow || getConfiguredServerUrl() !== configuredServerUrl
      || !trustedMainFrame(event, browserWindow, serverUrl.origin)) {
      return { ok: false, error: 'The Canvas window changed. Start the connection again.' };
    }
    try {
      await openExternal(request.authorizationUrl);
      return { ok: true };
    } catch {
      return { ok: false, error: 'The system browser could not be opened. Retry the connection.' };
    }
  };
}
