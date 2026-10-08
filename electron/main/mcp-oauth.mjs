import { createAuthorizedSharedOAuthLauncher, safeSharedOAuthWebUrl, trustedSharedMainFrame } from './shared-oauth-launcher.mjs';

const DESKTOP_STATE = /^desktop_[A-Za-z0-9_-]{32}$/u;

function safeWebUrl(value, allowLoopbackHttp) { return safeSharedOAuthWebUrl(value, allowLoopbackHttp); }
function trustedMainFrame(event, browserWindow, origin) { return trustedSharedMainFrame(event, browserWindow, origin); }

/** Shared launches use the common current-session fence; personal MCP keeps its existing owner-only behavior. */
export function createMcpOAuthLauncher({ getMainWindow, getConfiguredServerUrl, openExternal, allowLoopbackHttp = false }) {
  const sharedLauncher = createAuthorizedSharedOAuthLauncher({ provider: 'mcp', getMainWindow, getConfiguredServerUrl, openExternal, allowLoopbackHttp });
  return async (event, request) => {
    if (request?.target !== undefined) return sharedLauncher(event, request);
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
    const originalSession = browserWindow.webContents.session;
    try {
      const response = await originalSession.fetch(transactionUrl.href, {
        method: 'GET', credentials: 'include', redirect: 'error',
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || response.redirected) throw new Error('Transaction unavailable.');
      const body = await response.json();
      if (body?.success !== true || body.data?.status !== 'waiting' || body.data.authorizationUrl !== request.authorizationUrl) {
        return { ok: false, error: 'This OAuth request is no longer available. Start the connection again.' };
      }
      if (getMainWindow() !== browserWindow || getConfiguredServerUrl() !== configuredServerUrl
        || !trustedMainFrame(event, browserWindow, serverUrl.origin)) {
        return { ok: false, error: 'The Canvas window changed. Start the connection again.' };
      }
      try { await openExternal(request.authorizationUrl); return { ok: true }; }
      catch { return { ok: false, error: 'The system browser could not be opened. Retry the connection.' }; }
    } catch {
      return { ok: false, error: 'Canvas could not verify the OAuth request. Retry the connection.' };
    }
  };
}
