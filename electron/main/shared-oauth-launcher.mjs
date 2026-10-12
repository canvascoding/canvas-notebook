const CONNECTION_REF = /^canvas-connection:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MCP_STATE = /^desktop_[A-Za-z0-9_-]{32}$/u;
const COMPOSIO_STATE = /^[A-Za-z0-9_-]{43}$/u;
const MAX_AUTHORIZATION_URL_LENGTH = 16_384;

export function safeSharedOAuthWebUrl(value, allowLoopbackHttp) {
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

export function trustedSharedMainFrame(event, browserWindow, origin) {
  if (!browserWindow || browserWindow.isDestroyed() || browserWindow.webContents.isDestroyed()) return false;
  if (event.sender !== browserWindow.webContents || event.senderFrame !== browserWindow.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
}

function captureSharedOAuthRequest(provider, value, allowLoopbackHttp) {
  const keys = ['state', 'authorizationUrl', 'target', 'expiresAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key)) || typeof value.state !== 'string'
    || !(provider === 'mcp' ? MCP_STATE.test(value.state) : COMPOSIO_STATE.test(value.state)
      && Buffer.from(value.state, 'base64url').toString('base64url') === value.state)
    || !safeSharedOAuthWebUrl(value.authorizationUrl, allowLoopbackHttp)) return null;
  const target = value.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || Object.keys(target).some(key => !['kind', 'connectionRef', 'workspaceId'].includes(key))
    || target.kind !== 'shared' || typeof target.connectionRef !== 'string' || !CONNECTION_REF.test(target.connectionRef)
    || (target.workspaceId !== null && (typeof target.workspaceId !== 'string' || !target.workspaceId
      || target.workspaceId !== target.workspaceId.trim() || target.workspaceId.length > 200
      || /[\x00-\x1f\x7f]/u.test(target.workspaceId)))) return null;
  const expiresAt = value.expiresAt;
  if ((provider === 'composio' || expiresAt !== undefined) && (typeof expiresAt !== 'string' || expiresAt.length > 64
    || !Number.isFinite(Date.parse(expiresAt)) || new Date(Date.parse(expiresAt)).toISOString() !== expiresAt
    || Date.parse(expiresAt) <= Date.now())) return null;
  return Object.freeze({ state: value.state, authorizationUrl: value.authorizationUrl,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    target: Object.freeze({ kind: 'shared', connectionRef: target.connectionRef, workspaceId: target.workspaceId }) });
}

function sharedOAuthCookieMatchesHost(cookie, host) {
  if (!cookie || !['better-auth.session_token', '__Host-better-auth.session_token'].includes(cookie.name)) return false;
  const domain = typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./u, '').replace(/^\[|\]$/gu, '').toLowerCase() : null;
  return typeof domain === 'string' && (domain === host || (!cookie.hostOnly && host.endsWith(`.${domain}`)));
}
function sharedOAuthCookieKey(cookie) { return JSON.stringify([cookie.name, cookie.domain, cookie.path]); }

async function readSharedOAuthCookies(cookies, transactionUrl, host) {
  const values = (await cookies.get({ url: transactionUrl.href })).filter(cookie => sharedOAuthCookieMatchesHost(cookie, host));
  if (values.some(cookie => typeof cookie.value !== 'string' || !cookie.value)) throw new Error('Invalid Canvas cookie identity.');
  return values;
}

function sharedOAuthStatusUrl(provider, request, serverOrigin) {
  const ref = encodeURIComponent(request.target.connectionRef);
  const url = new URL(provider === 'mcp' ? `/api/mcp/shared-connections/${ref}/oauth/desktop`
    : `/api/composio/shared-connections/${ref}/connect/desktop`, serverOrigin);
  url.searchParams.set('state', request.state);
  if (request.target.workspaceId !== null) url.searchParams.set('workspaceId', request.target.workspaceId);
  return url;
}

function sharedOAuthWaitingSummary(body, request) {
  const data = body?.data;
  if (body?.success !== true || !data || typeof data !== 'object' || Array.isArray(data)
    || Object.keys(data).some(key => !['connectionRef', 'state', 'status', 'expiresAt', 'authorizationUrl'].includes(key))
    || data.status !== 'waiting' || data.connectionRef !== request.target.connectionRef || data.state !== request.state
    || data.authorizationUrl !== request.authorizationUrl || typeof data.expiresAt !== 'string' || data.expiresAt.length > 64
    || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now()
    || (request.expiresAt !== undefined && data.expiresAt !== request.expiresAt)) return null;
  return Date.parse(data.expiresAt);
}

function sharedOAuthRequestKey(provider, request, configuredServerUrl, frameUrl) {
  return JSON.stringify([provider, configuredServerUrl, frameUrl, request.target.connectionRef,
    request.target.workspaceId, request.state, request.authorizationUrl, request.expiresAt ?? null]);
}

async function runAuthorizedSharedOAuthOpen(context, request, transactionUrl, onSettled) {
  const { event, browserWindow, originalSession, configuredServerUrl, frameUrl, serverOrigin,
    getMainWindow, getConfiguredServerUrl, openExternal } = context;
  const webContents = browserWindow.webContents, cookies = originalSession.cookies;
  const host = new URL(serverOrigin).hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  let cookieValues = null, cookieIdentityChanged = false, navigationChanged = false;
  const registered = [];
  const cookieChanged = (_event, cookie, cause, removed) => {
    if (!sharedOAuthCookieMatchesHost(cookie, host)) return;
    // Expiry refresh can remove/reinsert the identical value. Every other identity change stays sticky.
    if (removed && cause === 'overwrite' && cookieValues?.get(sharedOAuthCookieKey(cookie)) === cookie.value) return;
    if (removed || !cookieValues || cookieValues.get(sharedOAuthCookieKey(cookie)) !== cookie.value) cookieIdentityChanged = true;
  };
  // Electron42: did-start-navigation uses a details object; did-navigate-in-page has positional isMainFrame.
  const navigationStarted = details => { if (details?.isMainFrame === true) navigationChanged = true; };
  const inPageNavigated = (_event, _url, isMainFrame) => { if (isMainFrame === true) navigationChanged = true; };
  const invalidateFrame = () => { navigationChanged = true; };
  const isCurrent = () => !navigationChanged && !cookieIdentityChanged && getMainWindow() === browserWindow
    && getConfiguredServerUrl() === configuredServerUrl && trustedSharedMainFrame(event, browserWindow, serverOrigin)
    && event.senderFrame.url === frameUrl && webContents.session === originalSession;
  const cookiesMatch = values => cookieValues && values.length === cookieValues.size
    && values.every(cookie => cookieValues.get(sharedOAuthCookieKey(cookie)) === cookie.value);
  try {
    for (const [emitter, name, listener] of [[cookies, 'changed', cookieChanged],
      [webContents, 'did-start-navigation', navigationStarted], [webContents, 'did-navigate-in-page', inPageNavigated],
      [webContents, 'did-navigate', invalidateFrame], [webContents, 'destroyed', invalidateFrame],
      [webContents, 'render-process-gone', invalidateFrame]]) {
      emitter.on(name, listener); registered.push([emitter, name, listener]);
    }
    const initial = await readSharedOAuthCookies(cookies, transactionUrl, host);
    cookieValues = new Map(initial.map(cookie => [sharedOAuthCookieKey(cookie), cookie.value]));
    if (!cookieValues.size || !isCurrent()) throw new Error('The initiating session changed.');
    const response = await originalSession.fetch(transactionUrl.href, { method: 'GET', credentials: 'include', redirect: 'error',
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok || response.redirected) throw new Error('Transaction unavailable.');
    const deadline = sharedOAuthWaitingSummary(await response.json(), request);
    if (deadline === null) return { ok: false, error: 'This OAuth request is no longer available. Start the connection again.' };
    const beforeOpen = await readSharedOAuthCookies(cookies, transactionUrl, host);
    // No await lies between this final deadline/context check and the actual system-browser request.
    if (!cookiesMatch(beforeOpen) || !isCurrent() || Date.now() >= deadline) {
      return { ok: false, error: 'The Canvas window or session changed. Start the connection again.' };
    }
    try { await openExternal(request.authorizationUrl); }
    catch { return { ok: false, error: 'The system browser could not be opened. Retry the connection.' }; }
    const afterOpen = await readSharedOAuthCookies(cookies, transactionUrl, host);
    if (!cookiesMatch(afterOpen) || !isCurrent() || Date.now() >= deadline) {
      return { ok: false, error: 'The Canvas window or session changed. Check this sign-in before retrying.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Canvas could not verify the OAuth request. Retry the connection.' };
  } finally {
    // Delete the in-flight identity before disposing watchers. Later calls always perform a fresh lookup.
    onSettled();
    for (const [emitter, name, listener] of registered.reverse()) emitter.removeListener(name, listener);
  }
}

/** Provider selection is internal. Renderer input cannot choose a status URL, backend or authentication identity. */
export function createAuthorizedSharedOAuthLauncher({ provider, getMainWindow, getConfiguredServerUrl, openExternal, allowLoopbackHttp = false }) {
  if (provider !== 'mcp' && provider !== 'composio') throw new Error('Unsupported internal shared OAuth provider.');
  const inFlight = new WeakMap();
  return async (event, input) => {
    try {
      const configuredServerUrl = getConfiguredServerUrl(), serverUrl = safeSharedOAuthWebUrl(configuredServerUrl, allowLoopbackHttp);
      const browserWindow = getMainWindow();
      if (!serverUrl || !trustedSharedMainFrame(event, browserWindow, serverUrl.origin)) {
        return { ok: false, error: 'OAuth can only be opened from the configured Canvas Notebook window.' };
      }
      const request = captureSharedOAuthRequest(provider, input, allowLoopbackHttp);
      if (!request) return { ok: false, error: 'The shared OAuth target is invalid. Start the connection again.' };
      const originalSession = browserWindow.webContents.session, webContents = browserWindow.webContents;
      const cookies = originalSession?.cookies;
      if (!cookies || typeof cookies.get !== 'function' || typeof cookies.on !== 'function' || typeof cookies.removeListener !== 'function'
        || typeof webContents.on !== 'function' || typeof webContents.removeListener !== 'function' || typeof originalSession.fetch !== 'function') {
        return { ok: false, error: 'Update the desktop app to connect this shared account.' };
      }
      const frame = event.senderFrame, frameUrl = frame.url;
      const key = sharedOAuthRequestKey(provider, request, configuredServerUrl, frameUrl);
      const entries = inFlight.get(browserWindow) ?? new Set(); inFlight.set(browserWindow, entries);
      const existing = [...entries].find(entry => entry.active && entry.session === originalSession && entry.frame === frame && entry.key === key);
      if (existing) return existing.promise;
      const entry = { active: true, session: originalSession, frame, key, promise: null };
      entry.promise = runAuthorizedSharedOAuthOpen({ event, browserWindow, originalSession, configuredServerUrl, frameUrl, serverOrigin: serverUrl.origin,
        getMainWindow, getConfiguredServerUrl, openExternal }, request, sharedOAuthStatusUrl(provider, request, serverUrl.origin),
      () => { entry.active = false; entries.delete(entry); });
      if (entry.active) entries.add(entry);
      return entry.promise;
    } catch {
      return { ok: false, error: 'Canvas could not verify the OAuth request. Retry the connection.' };
    }
  };
}
