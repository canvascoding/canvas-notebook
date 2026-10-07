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

    const shared = request.target !== undefined;
    if (shared && (!request.target || typeof request.target !== 'object' || Array.isArray(request.target)
      || Object.keys(request.target).some(key => !['kind', 'connectionRef', 'workspaceId'].includes(key))
      || request.target.kind !== 'shared' || typeof request.target.connectionRef !== 'string'
      || !/^canvas-connection:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(request.target.connectionRef)
      || (request.target.workspaceId !== null && (typeof request.target.workspaceId !== 'string'
        || !request.target.workspaceId || request.target.workspaceId !== request.target.workspaceId.trim()
        || request.target.workspaceId.length > 200 || /[\x00-\x1f\x7f]/u.test(request.target.workspaceId))))) {
      return { ok: false, error: 'The shared OAuth target is invalid. Start the connection again.' };
    }
    const target = shared ? { ...request.target } : null;
    const sharedFrameUrl = shared ? event.senderFrame.url : null;
    const transactionUrl = new URL(shared
      ? `/api/mcp/shared-connections/${encodeURIComponent(target.connectionRef)}/oauth/desktop`
      : '/api/mcp/oauth/desktop', serverUrl.origin);
    transactionUrl.searchParams.set('state', request.state);
    if (target?.workspaceId !== null && target?.workspaceId !== undefined) transactionUrl.searchParams.set('workspaceId', target.workspaceId);
    const originalSession = browserWindow.webContents.session;
    const cookies = shared ? originalSession.cookies : null;
    let cookieValues = null;
    let cookieIdentityChanged = false;
    // This fence is shared-only: the renderer cannot supply an authentication identity.
    const host = serverUrl.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    const authCookie = cookie => {
      if (!cookie || !['better-auth.session_token', '__Host-better-auth.session_token'].includes(cookie.name)) return false;
      const domain = cookie.domain?.replace(/^\./u, '').replace(/^\[|\]$/gu, '').toLowerCase();
      return typeof domain === 'string' && (domain === host || (!cookie.hostOnly && host.endsWith(`.${domain}`)));
    };
    const cookieKey = cookie => JSON.stringify([cookie.name, cookie.domain, cookie.path]);
    const cookieChanged = (_event, cookie, cause, removed) => {
      if (!authCookie(cookie)) return;
      // Chromium may remove an old cookie before refreshing its expiry with the same value.
      // A different inserted identity, explicit removal, or A→B→A still invalidates the request.
      if (removed && cause === 'overwrite' && cookieValues?.get(cookieKey(cookie)) === cookie.value) return;
      if (removed || !cookieValues || cookieValues.get(cookieKey(cookie)) !== cookie.value) cookieIdentityChanged = true;
    };
    if (shared && (!cookies || typeof cookies.get !== 'function' || typeof cookies.on !== 'function'
      || typeof cookies.removeListener !== 'function')) {
      return { ok: false, error: 'Update the desktop app to connect this shared account.' };
    }
    if (shared) cookies.on('changed', cookieChanged);
    let response;
    try {
      if (shared) {
        const initial = (await cookies.get({ url: transactionUrl.href })).filter(authCookie);
        cookieValues = new Map(initial.map(cookie => [cookieKey(cookie), cookie.value]));
        if (cookieIdentityChanged || !cookieValues.size || originalSession !== browserWindow.webContents.session) {
          throw new Error('The initiating session changed.');
        }
      }
      response = await originalSession.fetch(transactionUrl.href, {
        method: 'GET', credentials: 'include', redirect: 'error',
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || response.redirected) throw new Error('Transaction unavailable.');
      const body = await response.json();
      if (body?.success !== true || body.data?.status !== 'waiting'
        || body.data.authorizationUrl !== request.authorizationUrl
        || (shared && (body.data.connectionRef !== target.connectionRef || body.data.state !== request.state
          || typeof body.data.expiresAt !== 'string' || body.data.expiresAt.length > 64
          || !Number.isFinite(Date.parse(body.data.expiresAt)) || Date.parse(body.data.expiresAt) <= Date.now()))) {
        return { ok: false, error: 'This OAuth request is no longer available. Start the connection again.' };
      }
      if (shared) {
        const current = (await cookies.get({ url: transactionUrl.href })).filter(authCookie);
        if (cookieIdentityChanged || current.length !== cookieValues.size
          || current.some(cookie => cookieValues.get(cookieKey(cookie)) !== cookie.value)
          || originalSession !== browserWindow.webContents.session) {
          return { ok: false, error: 'The Canvas session changed. Start the connection again.' };
        }
      }
      // Recheck the frame and actual session immediately before opening the external browser.
      if (getMainWindow() !== browserWindow || getConfiguredServerUrl() !== configuredServerUrl
        || !trustedMainFrame(event, browserWindow, serverUrl.origin)
        || (shared && (event.senderFrame.url !== sharedFrameUrl || cookieIdentityChanged
          || originalSession !== browserWindow.webContents.session))) {
        return { ok: false, error: 'The Canvas window changed. Start the connection again.' };
      }
      try {
        await openExternal(request.authorizationUrl);
        return { ok: true };
      } catch {
        return { ok: false, error: 'The system browser could not be opened. Retry the connection.' };
      }
    } catch {
      return { ok: false, error: 'Canvas could not verify the OAuth request. Retry the connection.' };
    } finally {
      if (shared) cookies.removeListener('changed', cookieChanged);
    }
  };
}
