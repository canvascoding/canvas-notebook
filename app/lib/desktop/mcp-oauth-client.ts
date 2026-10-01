'use client';

export type McpAuthorizationFlow = { server: string; state: string; expiresAt: number; desktop: boolean };
type DesktopOAuthBridge = { openMcpOAuth?: (input: { state: string; authorizationUrl: string }) => Promise<{ ok: boolean; error?: string }> };
const STORAGE_KEY = 'canvas.mcp.authorization.v1';
const livePopups = new Map<string, Window>();

export class McpAuthorizationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'McpAuthorizationError'; }
}

export function readPendingMcpAuthorizations(): McpAuthorizationFlow[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((flow): flow is McpAuthorizationFlow => Boolean(flow && typeof flow === 'object'
      && typeof flow.server === 'string' && /^(?:desktop_)?[A-Za-z0-9_-]{32}$/u.test(flow.state)
      && typeof flow.desktop === 'boolean' && typeof flow.expiresAt === 'number' && flow.expiresAt > Date.now()));
  } catch { return []; }
}

export function rememberMcpAuthorization(flow: McpAuthorizationFlow): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...readPendingMcpAuthorizations().filter(item => item.server !== flow.server), flow])); } catch { /* In-memory polling still works when storage is unavailable. */ }
}

export function forgetMcpAuthorization(server: string): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(readPendingMcpAuthorizations().filter(flow => flow.server !== server))); } catch { /* Optional persistence. */ }
}

export async function cancelMcpAuthorization(flow: McpAuthorizationFlow): Promise<void> {
  forgetMcpAuthorization(flow.server);
  livePopups.get(flow.state)?.close();
  livePopups.delete(flow.state);
  if (flow.desktop) await fetch('/api/mcp/oauth/desktop', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: flow.state, action: 'cancel' }),
  }).catch(() => undefined);
}

/** Called directly from the click so a normal browser can reserve its popup. */
export async function startMcpAuthorization(server: string): Promise<McpAuthorizationFlow> {
  const bridge = (window as Window & { canvasDesktop?: DesktopOAuthBridge }).canvasDesktop;
  const desktop = Boolean(bridge);
  if (desktop && !bridge?.openMcpOAuth) throw new McpAuthorizationError('desktop_update_required', 'Update the desktop app to connect this account.');
  const popup = desktop ? null : window.open('about:blank', '_blank');
  if (!desktop && !popup) throw new McpAuthorizationError('popup_blocked', 'Allow popups to connect this account.');
  if (popup) popup.opener = null;
  let flow: McpAuthorizationFlow | undefined;
  try {
    const response = await fetch('/api/integrations/mcp-status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ server, action: 'authorize', desktop }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new McpAuthorizationError(payload.code || 'authorization_failed', payload.error || 'Could not start authorization.');
    const { authorizationUrl, state, expiresAt } = payload.data || {};
    if (typeof authorizationUrl !== 'string' || typeof state !== 'string'
      || !(desktop ? /^desktop_[A-Za-z0-9_-]{32}$/u : /^[A-Za-z0-9_-]{32}$/u).test(state)) throw new McpAuthorizationError('authorization_failed', 'Invalid authorization response.');
    const url = new URL(authorizationUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new McpAuthorizationError('authorization_failed', 'Invalid authorization URL.');
    const deadline = typeof expiresAt === 'number' ? expiresAt : typeof expiresAt === 'string' ? Date.parse(expiresAt) : Date.now() + 10 * 60_000;
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new McpAuthorizationError('authorization_expired', 'Authorization expired. Try connecting again.');
    flow = { server, state, desktop, expiresAt: deadline };
    if (desktop) {
      const opened = await bridge!.openMcpOAuth!({ state, authorizationUrl: url.toString() });
      if (!opened.ok) throw new McpAuthorizationError('external_browser_failed', opened.error || 'Could not open the system browser.');
    } else { popup!.location.href = url.toString(); livePopups.set(state, popup!); }
    rememberMcpAuthorization(flow);
    return flow;
  } catch (error) {
    popup?.close();
    if (flow) await cancelMcpAuthorization(flow);
    throw error;
  }
}

function pause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** A desktop result is finalized only by the original authenticated client. */
export async function waitForMcpAuthorization<T extends { oauth: Array<{ serverName: string; authorized: boolean; lastCompletedState?: string | null }> }>(
  flow: McpAuthorizationFlow,
  signal: AbortSignal,
  onStatus: (status: T) => void,
): Promise<void> {
  while (!signal.aborted && Date.now() < flow.expiresAt) {
    await pause(signal, 2000);
    if (signal.aborted) return;
    if (Date.now() >= flow.expiresAt) break;
    try {
      if (flow.desktop) {
        const response = await fetch(`/api/mcp/oauth/desktop?state=${encodeURIComponent(flow.state)}`, { credentials: 'include', cache: 'no-store', signal });
        const payload = await response.json();
        if (!response.ok || !payload.success) {
          if (response.status >= 500 && !payload.code) continue;
          throw new McpAuthorizationError(payload.code || 'authorization_failed', payload.error || 'Authorization is unavailable.');
        }
        let status = payload.data?.status;
        if (status === 'callback_received') {
          const finalized = await fetch('/api/mcp/oauth/desktop', {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, signal,
            body: JSON.stringify({ state: flow.state, action: 'finalize' }),
          });
          const result = await finalized.json();
          if (!finalized.ok || !result.success) throw new McpAuthorizationError(result.code || 'authorization_failed', result.error || 'Could not finish authorization.');
          status = result.data?.status;
        }
        if (['cancelled', 'expired', 'failed'].includes(status)) throw new McpAuthorizationError(`authorization_${status}`, payload.data?.error || 'Authorization did not complete.');
        if (status !== 'completed') continue;
      }
      const response = await fetch('/api/integrations/mcp-status', { credentials: 'include', cache: 'no-store', signal });
      const payload = await response.json();
      if (!response.ok || !payload.success) continue;
      const nextStatus = payload.data as T;
      onStatus(nextStatus);
      if (nextStatus.oauth.some(entry => entry.serverName === flow.server && entry.authorized && entry.lastCompletedState === flow.state)) {
        forgetMcpAuthorization(flow.server);
        livePopups.delete(flow.state);
        return;
      }
      if (!flow.desktop && livePopups.get(flow.state)?.closed) {
        livePopups.delete(flow.state);
        throw new McpAuthorizationError('authorization_cancelled', 'Sign-in was cancelled.');
      }
    } catch (error) {
      if (error instanceof McpAuthorizationError) { forgetMcpAuthorization(flow.server); throw error; }
      if (signal.aborted) return;
      // Provider/network failures can be transient; the transaction deadline bounds retries.
    }
  }
  if (!signal.aborted) {
    forgetMcpAuthorization(flow.server);
    throw new McpAuthorizationError('authorization_expired', 'Authorization expired. Try connecting again.');
  }
}
