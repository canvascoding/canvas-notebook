'use client';

export type SharedMcpAuthorizationTarget = Readonly<{ connectionRef: string; workspaceId: string | null }>;
export type SharedMcpAuthorizationFlow = SharedMcpAuthorizationTarget & Readonly<{ state: string; expiresAt: number }>;
export type SharedMcpAuthorizationRevisions = Readonly<{
  expectedMetadataRevision: number; expectedGrantsRevision: number; expectedBindingRevision: number;
}>;
export type SharedMcpAuthorizationSummary = Readonly<{
  connectionRef: string; state: string; expiresAt: string;
  status: 'waiting' | 'callback_received' | 'completed' | 'cancelled' | 'expired' | 'failed';
  authorizationUrl?: string; code?: string;
}>;
export type SharedMcpAuthorizationApi = (
  url: string, body?: unknown, method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
) => Promise<unknown>;
export type SharedMcpAuthorizationOptions = {
  api: SharedMcpAuthorizationApi;
  signal: AbortSignal;
  isCurrent: () => boolean;
  returnLocale?: 'de' | 'en';
  onStarted?: (flow: SharedMcpAuthorizationFlow) => void;
  onStatus?: (summary: SharedMcpAuthorizationSummary) => void;
};
type SharedDesktopBridge = {
  sharedMcpOAuthVersion?: number;
  openMcpOAuth?: (request: { state: string; authorizationUrl: string;
    target: SharedMcpAuthorizationTarget & { kind: 'shared' } }) => Promise<{ ok: boolean }>;
};
type FlowReceipt = { authorizationUrl: string; isCurrent: () => boolean; expiresAt: string };
const flows = new WeakMap<SharedMcpAuthorizationFlow, FlowReceipt>();
const CONNECTION_REF = /^canvas-connection:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DESKTOP_STATE = /^desktop_[A-Za-z0-9_-]{32}$/u;
const STATUSES = ['waiting', 'callback_received', 'completed', 'cancelled', 'expired', 'failed'] as const;
const CODES = ['CONNECTION_DESKTOP_OAUTH_CANCELLED', 'CONNECTION_DESKTOP_OAUTH_EXPIRED', 'CONNECTION_DESKTOP_OAUTH_FAILED'];
const REQUEST_CODES = [...CODES, 'CONNECTION_ACCESS_DENIED', 'CONNECTION_MANAGEMENT_REQUIRED', 'CONNECTION_BINDING_CHANGED',
  'CONNECTION_BINDING_INVALID', 'CONNECTION_CONTEXT_CHANGED', 'CONNECTION_NOT_FOUND', 'CONNECTION_REQUEST_INVALID',
  'CONNECTION_REVISION_CONFLICT', 'CONNECTION_REVISION_REQUIRED', 'CONNECTION_SCOPE_INVALID', 'CONNECTION_TARGET_INVALID',
  'CONNECTION_DESKTOP_OAUTH_BUSY', 'CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'CONNECTION_OAUTH_PROVIDER_ERROR',
  'CONNECTION_OAUTH_RETURN_INVALID', 'CONNECTION_OAUTH_STATE_INVALID', 'unauthorized', 'invalid_request', 'binding_changed',
  'provider_denied', 'provider_unavailable', 'rate_limit_exceeded'];

export class SharedMcpAuthorizationError extends Error {
  constructor(readonly code: string, message: string, readonly status: number | null = null) {
    super(message); this.name = 'SharedMcpAuthorizationError';
  }
}

function captureSharedMcpAuthorizationTarget(target: SharedMcpAuthorizationTarget): SharedMcpAuthorizationTarget {
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || Object.keys(target).some(key => key !== 'connectionRef' && key !== 'workspaceId')
    || typeof target.connectionRef !== 'string' || !CONNECTION_REF.test(target.connectionRef)
    || (target.workspaceId !== null && (typeof target.workspaceId !== 'string' || !target.workspaceId
      || target.workspaceId !== target.workspaceId.trim() || target.workspaceId.length > 200
      || /[\x00-\x1f\x7f]/u.test(target.workspaceId)))) {
    throw new SharedMcpAuthorizationError('authorization_invalid', 'Choose an exact shared connection and workspace.');
  }
  return Object.freeze({ connectionRef: target.connectionRef, workspaceId: target.workspaceId });
}

function sharedMcpAuthorizationPath(target: SharedMcpAuthorizationTarget, desktop: boolean, state?: string): string {
  const query = new URLSearchParams();
  if (target.workspaceId !== null) query.set('workspaceId', target.workspaceId);
  if (state !== undefined) query.set('state', state);
  const suffix = query.size ? `?${query}` : '';
  return `/api/mcp/shared-connections/${encodeURIComponent(target.connectionRef)}/oauth${desktop ? '/desktop' : ''}${suffix}`;
}

function assertSharedMcpAuthorizationCurrent(options: SharedMcpAuthorizationOptions, flow?: SharedMcpAuthorizationFlow): void {
  if (options.signal.aborted || !options.isCurrent() || (flow && !flows.get(flow)?.isCurrent())) {
    throw new SharedMcpAuthorizationError('authorization_context_changed', 'The sign-in session or selection changed.');
  }
}

async function requestSharedMcpAuthorization(options: SharedMcpAuthorizationOptions, path: string,
  body?: unknown, flow?: SharedMcpAuthorizationFlow): Promise<unknown> {
  assertSharedMcpAuthorizationCurrent(options, flow);
  let value: unknown;
  try { value = await options.api(path, body, body === undefined ? undefined : 'POST'); }
  catch (failure) {
    assertSharedMcpAuthorizationCurrent(options, flow);
    const error = failure as { status?: unknown; code?: unknown } | null;
    const status = error && typeof error.status === 'number' && Number.isSafeInteger(error.status)
      && error.status >= 400 && error.status <= 599 ? error.status : null;
    const code = status !== null && typeof error?.code === 'string' && REQUEST_CODES.includes(error.code)
      ? error.code : 'authorization_unavailable';
    throw new SharedMcpAuthorizationError(code, 'Shared sign-in is unavailable. Check its status or reload.', status);
  }
  assertSharedMcpAuthorizationCurrent(options, flow);
  return value;
}

function parseSharedMcpAuthorizationStart(value: unknown, target: SharedMcpAuthorizationTarget,
  isCurrent: () => boolean): SharedMcpAuthorizationFlow {
  const data = value as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.connectionRef !== target.connectionRef
    || data.desktop !== true || typeof data.state !== 'string' || !DESKTOP_STATE.test(data.state)
    || typeof data.expiresAt !== 'string' || data.expiresAt.length > 64 || !Number.isFinite(Date.parse(data.expiresAt))
    || Date.parse(data.expiresAt) <= Date.now() || typeof data.authorizationUrl !== 'string'
    || data.authorizationUrl.length > 16_384 || /[\u0000-\u0020\u007f]/u.test(data.authorizationUrl)) {
    throw new SharedMcpAuthorizationError('authorization_invalid', 'The shared sign-in response is invalid. Reload and start again.');
  }
  try {
    const url = new URL(data.authorizationUrl);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error();
  } catch {
    throw new SharedMcpAuthorizationError('authorization_invalid', 'The shared sign-in URL is invalid. Reload and start again.');
  }
  const flow = Object.freeze({ ...target, state: data.state, expiresAt: Date.parse(data.expiresAt) });
  flows.set(flow, { authorizationUrl: data.authorizationUrl, expiresAt: data.expiresAt, isCurrent });
  return flow;
}

function parseSharedMcpAuthorizationSummary(value: unknown, flow: SharedMcpAuthorizationFlow): SharedMcpAuthorizationSummary {
  const receipt = flows.get(flow), data = value as Record<string, unknown> | null;
  if (!receipt || !data || typeof data !== 'object' || Array.isArray(data)
    || data.connectionRef !== flow.connectionRef || data.state !== flow.state || data.expiresAt !== receipt.expiresAt
    || typeof data.status !== 'string' || !STATUSES.includes(data.status as SharedMcpAuthorizationSummary['status'])
    || (data.status === 'waiting' ? data.authorizationUrl !== receipt.authorizationUrl : data.authorizationUrl !== undefined)
    || (data.code !== undefined && (typeof data.code !== 'string' || !CODES.includes(data.code)))) {
    throw new SharedMcpAuthorizationError('authorization_invalid', 'The shared sign-in status does not match this connection.');
  }
  return Object.freeze({ connectionRef: flow.connectionRef, state: flow.state, expiresAt: receipt.expiresAt,
    status: data.status as SharedMcpAuthorizationSummary['status'],
    ...(data.status === 'waiting' ? { authorizationUrl: receipt.authorizationUrl } : {}),
    ...(typeof data.code === 'string' ? { code: data.code } : {}) });
}

/** Every mutation uses the parent's current-identity API write fence. No shared state is persisted in the renderer. */
export async function startSharedMcpAuthorization(targetInput: SharedMcpAuthorizationTarget,
  revisions: SharedMcpAuthorizationRevisions, options: SharedMcpAuthorizationOptions & {
    onStarted: (flow: SharedMcpAuthorizationFlow) => void;
  }): Promise<SharedMcpAuthorizationFlow> {
  const target = captureSharedMcpAuthorizationTarget(targetInput);
  const bridge = (window as Window & { canvasDesktop?: SharedDesktopBridge }).canvasDesktop;
  if (bridge?.sharedMcpOAuthVersion !== 1 || typeof bridge.openMcpOAuth !== 'function') {
    throw new SharedMcpAuthorizationError('desktop_update_required', 'Update the desktop app to connect this shared account.');
  }
  const captured = { expectedMetadataRevision: revisions.expectedMetadataRevision,
    expectedGrantsRevision: revisions.expectedGrantsRevision, expectedBindingRevision: revisions.expectedBindingRevision };
  if (Object.keys(revisions).some(key => !Object.hasOwn(captured, key))
    || Object.values(captured).some(value => !Number.isSafeInteger(value) || value < 1)
    || (options.returnLocale !== undefined && options.returnLocale !== 'de' && options.returnLocale !== 'en')) {
    throw new SharedMcpAuthorizationError('authorization_invalid', 'Reload the current connection before starting sign-in.');
  }
  const value = await requestSharedMcpAuthorization(options, sharedMcpAuthorizationPath(target, false), {
    ...captured, desktop: true, ...(options.returnLocale ? { returnLocale: options.returnLocale } : {}),
  });
  const flow = parseSharedMcpAuthorizationStart(value, target, options.isCurrent);
  assertSharedMcpAuthorizationCurrent(options, flow);
  options.onStarted(flow);
  assertSharedMcpAuthorizationCurrent(options, flow);
  let opened = false;
  try {
    opened = (await bridge.openMcpOAuth({ state: flow.state, authorizationUrl: flows.get(flow)!.authorizationUrl,
      target: { kind: 'shared', ...target } }))?.ok === true;
  } catch { /* A failed opener is cancelled only by the unchanged initiating UI identity. */ }
  assertSharedMcpAuthorizationCurrent(options, flow);
  if (!opened) {
    try { await cancelSharedMcpAuthorization(flow, options); }
    catch (failure) {
      assertSharedMcpAuthorizationCurrent(options, flow);
      if (failure instanceof SharedMcpAuthorizationError && failure.status !== null && failure.status < 500) throw failure;
      throw new SharedMcpAuthorizationError('authorization_cancel_unconfirmed', 'The browser could not open. Cancellation is unconfirmed; check this sign-in.',
        failure instanceof SharedMcpAuthorizationError ? failure.status : null);
    }
    throw new SharedMcpAuthorizationError('external_browser_failed', 'The system browser could not be opened. Start sign-in again.');
  }
  return flow;
}

export async function readSharedMcpAuthorizationStatus(flow: SharedMcpAuthorizationFlow,
  options: SharedMcpAuthorizationOptions): Promise<SharedMcpAuthorizationSummary> {
  const value = await requestSharedMcpAuthorization(options, sharedMcpAuthorizationPath(flow, true, flow.state), undefined, flow);
  const status = parseSharedMcpAuthorizationSummary(value, flow);
  options.onStatus?.(status);
  return status;
}

export async function finalizeSharedMcpAuthorization(flow: SharedMcpAuthorizationFlow,
  options: SharedMcpAuthorizationOptions): Promise<SharedMcpAuthorizationSummary> {
  const value = await requestSharedMcpAuthorization(options, sharedMcpAuthorizationPath(flow, true), { state: flow.state, action: 'finalize' }, flow);
  const status = parseSharedMcpAuthorizationSummary(value, flow);
  if (status.status === 'waiting') throw new SharedMcpAuthorizationError('authorization_invalid', 'The shared sign-in has no completed callback.');
  options.onStatus?.(status);
  return status;
}

export async function cancelSharedMcpAuthorization(flow: SharedMcpAuthorizationFlow,
  options: SharedMcpAuthorizationOptions): Promise<SharedMcpAuthorizationSummary> {
  const value = await requestSharedMcpAuthorization(options, sharedMcpAuthorizationPath(flow, true), { state: flow.state, action: 'cancel' }, flow);
  const status = parseSharedMcpAuthorizationSummary(value, flow);
  if (status.status === 'waiting' || status.status === 'callback_received') {
    throw new SharedMcpAuthorizationError('authorization_cancel_unconfirmed', 'Cancellation is unconfirmed; check this shared sign-in.');
  }
  options.onStatus?.(status);
  return status;
}

function sharedMcpAuthorizationPause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Poll only this issued flow. An unconfirmed mutation ACK is surfaced, never automatically retried. */
export async function waitForSharedMcpAuthorization(flow: SharedMcpAuthorizationFlow,
  options: SharedMcpAuthorizationOptions): Promise<SharedMcpAuthorizationSummary> {
  while (true) {
    assertSharedMcpAuthorizationCurrent(options, flow);
    let status = await readSharedMcpAuthorizationStatus(flow, options);
    if (status.status === 'callback_received') status = await finalizeSharedMcpAuthorization(flow, options);
    if (status.status !== 'waiting' && status.status !== 'callback_received') return status;
    if (Date.now() >= flow.expiresAt) throw new SharedMcpAuthorizationError('authorization_expired', 'Shared sign-in expired. Check its status or start again.');
    await sharedMcpAuthorizationPause(options.signal, Math.min(2000, flow.expiresAt - Date.now()));
  }
}
