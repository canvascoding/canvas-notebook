'use client';

import type { SharedComposioDesktopOAuthSummary } from '@/app/lib/composio/composio-shared-desktop-oauth-contract';

export type SharedComposioAuthorizationTarget = Readonly<{ connectionRef: string; workspaceId: string | null }>;
export type SharedComposioAuthorizationFlow = SharedComposioAuthorizationTarget & Readonly<{ intent: string }>;
export type SharedComposioAuthorizationRevisions = Readonly<{
  expectedMetadataRevision: number; expectedGrantsRevision: number; expectedBindingRevision: number;
}>;
export type SharedComposioAuthorizationSummary = SharedComposioDesktopOAuthSummary;
export type SharedComposioAuthorizationApi = (
  url: string, body?: unknown, method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
) => Promise<unknown>;
export type SharedComposioAuthorizationOptions = {
  api: SharedComposioAuthorizationApi;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onStarted?: (flow: SharedComposioAuthorizationFlow) => void;
  onStatus?: (summary: SharedComposioAuthorizationSummary) => void;
};
export type SharedComposioAuthorizationStartResult = SharedComposioAuthorizationFlow | Readonly<{ connectionRef: string; noAuth: true }>;
type SharedComposioDesktopBridge = {
  sharedComposioOAuthVersion?: number;
  openSharedComposioOAuth?: (request: { state: string; authorizationUrl: string; expiresAt: string;
    target: SharedComposioAuthorizationTarget & { kind: 'shared' } }) => Promise<{ ok: boolean }>;
};
type FlowReceipt = {
  revisions: SharedComposioAuthorizationRevisions;
  isCurrent: () => boolean;
  state?: string;
  expiresAt?: string;
  authorizationUrl?: string;
  lastStatus?: SharedComposioAuthorizationSummary['status'];
  opener: 'not_attempted' | 'opening' | 'acknowledged' | 'unconfirmed';
  finalizeUnconfirmed: boolean;
  noAuth: boolean;
};
const flows = new WeakMap<SharedComposioAuthorizationFlow, FlowReceipt>();
const CONNECTION_REF = /^canvas-connection:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STATE = /^[A-Za-z0-9_-]{43}$/u;
const STATUSES = ['starting', 'waiting', 'callback_received', 'completed', 'cancelled', 'expired', 'failed'] as const;
const STATUS_CODES = {
  starting: 'CONNECTION_DESKTOP_OAUTH_START_UNCONFIRMED', cancelled: 'CONNECTION_DESKTOP_OAUTH_CANCELLED',
  expired: 'CONNECTION_DESKTOP_OAUTH_EXPIRED', failed: 'CONNECTION_DESKTOP_OAUTH_FAILED',
} as const;
const STATUS_ERRORS = {
  starting: 'Shared sign-in start is unconfirmed. Reload and check this sign-in.', cancelled: 'Shared sign-in was cancelled.',
  expired: 'Shared sign-in expired. Start again.', failed: 'Shared sign-in could not be completed. Reload and start again.',
} as const;
const PERMANENT_CODES = ['CONNECTION_ACCESS_DENIED', 'CONNECTION_MANAGEMENT_REQUIRED', 'CONNECTION_BINDING_CHANGED',
  'CONNECTION_BINDING_INVALID', 'CONNECTION_CONTEXT_CHANGED', 'CONNECTION_REVISION_CONFLICT', 'CONNECTION_REVISION_REQUIRED',
  'CONNECTION_SCOPE_INVALID', 'CONNECTION_TARGET_INVALID', 'CONNECTION_REQUEST_INVALID', 'CONNECTION_NOT_FOUND',
  'CONNECTION_DESKTOP_OAUTH_SNAPSHOT_INVALID', 'CONNECTION_DESKTOP_OAUTH_STATE_INVALID', 'unauthorized', 'invalid_request',
  'binding_changed', 'provider_denied'];
const REQUEST_CODES = [...PERMANENT_CODES, ...Object.values(STATUS_CODES), 'auth_required', 'outcome_unknown',
  'CONNECTION_DESKTOP_OAUTH_BUSY', 'provider_unavailable', 'setup_required', 'rate_limit_exceeded',
  'master_key_missing', 'decryption_failed', 'invalid_secret_format', 'mcp_credential_key_missing'];

export class SharedComposioAuthorizationError extends Error {
  constructor(readonly code: string, message: string, readonly status: number | null = null) {
    super(message); this.name = 'SharedComposioAuthorizationError';
  }
}

/** A missing recovery row, provider readiness and an unconfirmed outcome never establish cancellation. */
export function isSharedComposioAuthorizationPermanentError(value: unknown): value is SharedComposioAuthorizationError {
  return value instanceof SharedComposioAuthorizationError && value.status !== null
    && [400, 401, 403, 409, 410].includes(value.status) && PERMANENT_CODES.includes(value.code);
}

function captureSharedComposioAuthorizationTarget(target: SharedComposioAuthorizationTarget): SharedComposioAuthorizationTarget {
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || Object.keys(target).some(key => key !== 'connectionRef' && key !== 'workspaceId')
    || typeof target.connectionRef !== 'string' || !CONNECTION_REF.test(target.connectionRef)
    || (target.workspaceId !== null && (typeof target.workspaceId !== 'string' || !target.workspaceId
      || target.workspaceId !== target.workspaceId.trim() || target.workspaceId.length > 200
      || /[\x00-\x1f\x7f]/u.test(target.workspaceId)))) {
    throw new SharedComposioAuthorizationError('authorization_invalid', 'Choose an exact shared app connection and workspace.');
  }
  return Object.freeze({ connectionRef: target.connectionRef, workspaceId: target.workspaceId });
}

function createSharedComposioAuthorizationIntent(): string {
  const bytes = window.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function sharedComposioAuthorizationPath(flow: SharedComposioAuthorizationFlow, desktop: boolean, read = false): string {
  const receipt = flows.get(flow);
  if (!receipt) throw new SharedComposioAuthorizationError('authorization_invalid', 'A current shared app sign-in is required.');
  const query = new URLSearchParams();
  if (flow.workspaceId !== null) query.set('workspaceId', flow.workspaceId);
  if (read) query.set(receipt.state ? 'state' : 'intent', receipt.state ?? flow.intent);
  return `/api/composio/shared-connections/${encodeURIComponent(flow.connectionRef)}/connect${desktop ? '/desktop' : ''}${query.size ? `?${query}` : ''}`;
}

function assertSharedComposioAuthorizationCurrent(options: SharedComposioAuthorizationOptions, flow: SharedComposioAuthorizationFlow): FlowReceipt {
  const receipt = flows.get(flow);
  if (!receipt) throw new SharedComposioAuthorizationError('authorization_invalid', 'A current shared app sign-in is required.');
  if (options.signal.aborted || !options.isCurrent() || !receipt.isCurrent()) {
    throw new SharedComposioAuthorizationError('authorization_context_changed', 'The sign-in session or selection changed.');
  }
  if (receipt.noAuth) throw new SharedComposioAuthorizationError('authorization_completed', 'This app setup is already confirmed.');
  return receipt;
}

async function requestSharedComposioAuthorization(options: SharedComposioAuthorizationOptions, flow: SharedComposioAuthorizationFlow,
  path: string, body?: unknown): Promise<unknown> {
  assertSharedComposioAuthorizationCurrent(options, flow);
  let value: unknown;
  try { value = await options.api(path, body, body === undefined ? undefined : 'POST'); }
  catch (failure) {
    assertSharedComposioAuthorizationCurrent(options, flow);
    const error = failure as { status?: unknown; code?: unknown } | null;
    const status = typeof error?.status === 'number' && Number.isSafeInteger(error.status)
      && error.status >= 400 && error.status <= 599 ? error.status : null;
    const code = status !== null && typeof error?.code === 'string' && REQUEST_CODES.includes(error.code)
      ? error.code : 'authorization_unavailable';
    throw new SharedComposioAuthorizationError(code, 'Shared app sign-in is unconfirmed. Check its status or cancel this sign-in.', status);
  }
  assertSharedComposioAuthorizationCurrent(options, flow);
  return value;
}

function parseSharedComposioAuthorizationSummary(value: unknown, flow: SharedComposioAuthorizationFlow): SharedComposioAuthorizationSummary {
  const receipt = flows.get(flow), data = value as Record<string, unknown> | null;
  if (!receipt || !data || typeof data !== 'object' || Array.isArray(data)
    || Object.keys(data).some(key => !['connectionRef', 'state', 'expiresAt', 'status', 'authorizationUrl', 'code', 'error'].includes(key))
    || data.connectionRef !== flow.connectionRef || typeof data.state !== 'string' || !STATE.test(data.state)
    || (receipt.state !== undefined && data.state !== receipt.state)
    || typeof data.expiresAt !== 'string' || data.expiresAt.length > 64 || !Number.isFinite(Date.parse(data.expiresAt))
    || new Date(data.expiresAt).toISOString() !== data.expiresAt
    || Date.parse(data.expiresAt) <= 0 || (receipt.expiresAt !== undefined && data.expiresAt !== receipt.expiresAt)
    || typeof data.status !== 'string' || !STATUSES.includes(data.status as SharedComposioAuthorizationSummary['status'])) {
    throw new SharedComposioAuthorizationError('authorization_invalid', 'The shared app sign-in response does not match this attempt.');
  }
  try {
    const decoded = atob(data.state.replace(/-/gu, '+').replace(/_/gu, '/') + '=');
    if (decoded.length !== 32 || btoa(decoded).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '') !== data.state) throw new Error();
  } catch { throw new SharedComposioAuthorizationError('authorization_invalid', 'The shared app sign-in state is invalid.'); }
  if (data.status === 'waiting') {
    if (typeof data.authorizationUrl !== 'string' || data.authorizationUrl.length > 16_384
      || /[\u0000-\u0020\u007f]/u.test(data.authorizationUrl) || Date.parse(data.expiresAt) <= Date.now()
      || (receipt.authorizationUrl !== undefined && data.authorizationUrl !== receipt.authorizationUrl)) {
      throw new SharedComposioAuthorizationError('authorization_invalid', 'The shared app sign-in address is invalid.');
    }
    try {
      const url = new URL(data.authorizationUrl);
      const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(url.hostname);
      if (url.username || url.password || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error();
    } catch { throw new SharedComposioAuthorizationError('authorization_invalid', 'The shared app sign-in address is invalid.'); }
  } else if (data.authorizationUrl !== undefined) {
    throw new SharedComposioAuthorizationError('authorization_invalid', 'The shared app sign-in status contains an unexpected address.');
  }
  const expectedCode = Object.hasOwn(STATUS_CODES, data.status) ? STATUS_CODES[data.status as keyof typeof STATUS_CODES] : undefined;
  const expectedError = Object.hasOwn(STATUS_ERRORS, data.status) ? STATUS_ERRORS[data.status as keyof typeof STATUS_ERRORS] : undefined;
  if (data.status === 'starting' && data.code === undefined && data.error === undefined) {
    // The initial in-progress form is permitted by the server contract.
  } else if (data.code !== expectedCode || data.error !== expectedError) {
    throw new SharedComposioAuthorizationError('authorization_invalid', 'The shared app sign-in status is invalid.');
  }
  receipt.state = data.state; receipt.expiresAt = data.expiresAt;
  if (data.status === 'waiting') receipt.authorizationUrl = data.authorizationUrl as string;
  receipt.lastStatus = data.status as SharedComposioAuthorizationSummary['status'];
  return Object.freeze({ connectionRef: flow.connectionRef, state: receipt.state, expiresAt: receipt.expiresAt,
    status: data.status, ...(data.status === 'waiting' ? { authorizationUrl: receipt.authorizationUrl } : {}),
    ...(data.code === undefined ? {} : { code: expectedCode, error: expectedError }) }) as SharedComposioAuthorizationSummary;
}

async function openSharedComposioAuthorizationBrowser(flow: SharedComposioAuthorizationFlow,
  options: SharedComposioAuthorizationOptions, explicitResume = false): Promise<void> {
  const receipt = assertSharedComposioAuthorizationCurrent(options, flow);
  if (receipt.opener === 'acknowledged') return;
  if (receipt.opener === 'opening' || receipt.opener === 'unconfirmed' && !explicitResume) {
    throw new SharedComposioAuthorizationError('authorization_open_unconfirmed', 'The browser opening is unconfirmed. Check this sign-in.');
  }
  const bridge = (window as Window & { canvasDesktop?: SharedComposioDesktopBridge }).canvasDesktop;
  if (bridge?.sharedComposioOAuthVersion !== 1 || typeof bridge.openSharedComposioOAuth !== 'function') {
    throw new SharedComposioAuthorizationError('desktop_update_required', 'Update the desktop app to connect this shared app.');
  }
  if (receipt.lastStatus !== 'waiting' || !receipt.state || !receipt.expiresAt || !receipt.authorizationUrl
    || Date.parse(receipt.expiresAt) <= Date.now()) {
    throw new SharedComposioAuthorizationError('authorization_not_ready', 'Check the current shared app sign-in before opening the browser.');
  }
  receipt.opener = 'opening';
  let opened = false;
  try {
    opened = (await bridge.openSharedComposioOAuth({ state: receipt.state, authorizationUrl: receipt.authorizationUrl,
      expiresAt: receipt.expiresAt, target: { kind: 'shared', connectionRef: flow.connectionRef, workspaceId: flow.workspaceId } }))?.ok === true;
  } catch { /* A lost opener ACK leaves the same attempt available for explicit recovery. */ }
  receipt.opener = opened ? 'acknowledged' : 'unconfirmed';
  assertSharedComposioAuthorizationCurrent(options, flow);
  if (!opened) throw new SharedComposioAuthorizationError('authorization_open_unconfirmed', 'The browser opening is unconfirmed. Check this sign-in or cancel it.');
}

/** The synchronous attempt callback precedes the first POST, including a response that may be lost. */
export async function startSharedComposioAuthorization(targetInput: SharedComposioAuthorizationTarget,
  revisions: SharedComposioAuthorizationRevisions, options: SharedComposioAuthorizationOptions & {
    onStarted: (flow: SharedComposioAuthorizationFlow) => void;
  }): Promise<SharedComposioAuthorizationStartResult> {
  const target = captureSharedComposioAuthorizationTarget(targetInput);
  const bridge = (window as Window & { canvasDesktop?: SharedComposioDesktopBridge }).canvasDesktop;
  if (bridge?.sharedComposioOAuthVersion !== 1 || typeof bridge.openSharedComposioOAuth !== 'function') {
    throw new SharedComposioAuthorizationError('desktop_update_required', 'Update the desktop app to connect this shared app.');
  }
  const captured = Object.freeze({ expectedMetadataRevision: revisions.expectedMetadataRevision,
    expectedGrantsRevision: revisions.expectedGrantsRevision, expectedBindingRevision: revisions.expectedBindingRevision });
  if (Object.keys(revisions).some(key => !Object.hasOwn(captured, key))
    || Object.values(captured).some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new SharedComposioAuthorizationError('authorization_invalid', 'Reload the current connection before starting shared app sign-in.');
  }
  const flow = Object.freeze({ ...target, intent: createSharedComposioAuthorizationIntent() });
  const receipt: FlowReceipt = { revisions: captured, isCurrent: options.isCurrent, opener: 'not_attempted', finalizeUnconfirmed: false, noAuth: false };
  flows.set(flow, receipt); assertSharedComposioAuthorizationCurrent(options, flow);
  options.onStarted(flow); assertSharedComposioAuthorizationCurrent(options, flow);
  const value = await requestSharedComposioAuthorization(options, flow, sharedComposioAuthorizationPath(flow, false),
    { ...captured, desktop: true, intent: flow.intent });
  if (value && typeof value === 'object' && !Array.isArray(value) && Reflect.get(value, 'noAuth') === true) {
    if (Reflect.get(value, 'connectionRef') !== flow.connectionRef || Object.keys(value).some(key => key !== 'connectionRef' && key !== 'noAuth')) {
      throw new SharedComposioAuthorizationError('authorization_invalid', 'The shared app setup response is invalid.');
    }
    receipt.noAuth = true;
    return Object.freeze({ connectionRef: flow.connectionRef, noAuth: true });
  }
  const status = parseSharedComposioAuthorizationSummary(value, flow);
  options.onStatus?.(status); assertSharedComposioAuthorizationCurrent(options, flow);
  if (status.status === 'starting') throw new SharedComposioAuthorizationError('authorization_start_unconfirmed', 'The shared app start is unconfirmed. Check or cancel this sign-in.');
  if (status.status === 'waiting') await openSharedComposioAuthorizationBrowser(flow, options);
  return flow;
}

export async function readSharedComposioAuthorizationStatus(flow: SharedComposioAuthorizationFlow,
  options: SharedComposioAuthorizationOptions): Promise<SharedComposioAuthorizationSummary> {
  const value = await requestSharedComposioAuthorization(options, flow, sharedComposioAuthorizationPath(flow, true, true));
  const status = parseSharedComposioAuthorizationSummary(value, flow);
  options.onStatus?.(status); assertSharedComposioAuthorizationCurrent(options, flow);
  return status;
}

export async function finalizeSharedComposioAuthorization(flow: SharedComposioAuthorizationFlow,
  options: SharedComposioAuthorizationOptions): Promise<SharedComposioAuthorizationSummary> {
  const receipt = assertSharedComposioAuthorizationCurrent(options, flow);
  if (!receipt.state || receipt.lastStatus !== 'callback_received' || receipt.finalizeUnconfirmed) {
    throw new SharedComposioAuthorizationError('authorization_finalize_unconfirmed', 'Read the current shared app sign-in before explicitly completing it.');
  }
  receipt.finalizeUnconfirmed = true;
  let value: unknown;
  try { value = await requestSharedComposioAuthorization(options, flow, sharedComposioAuthorizationPath(flow, true), { state: receipt.state, action: 'finalize' }); }
  catch (failure) {
    if (failure instanceof SharedComposioAuthorizationError && (failure.code === 'auth_required' || isSharedComposioAuthorizationPermanentError(failure))) receipt.finalizeUnconfirmed = false;
    throw failure;
  }
  const status = parseSharedComposioAuthorizationSummary(value, flow);
  if (status.status === 'starting' || status.status === 'waiting' || status.status === 'callback_received') {
    throw new SharedComposioAuthorizationError('authorization_finalize_unconfirmed', 'Shared app completion is unconfirmed. Check this sign-in.');
  }
  receipt.finalizeUnconfirmed = false;
  options.onStatus?.(status); assertSharedComposioAuthorizationCurrent(options, flow);
  return status;
}

export async function cancelSharedComposioAuthorization(flow: SharedComposioAuthorizationFlow,
  options: SharedComposioAuthorizationOptions): Promise<SharedComposioAuthorizationSummary> {
  const receipt = assertSharedComposioAuthorizationCurrent(options, flow);
  const body = receipt.state ? { state: receipt.state, action: 'cancel' }
    : { intent: flow.intent, action: 'cancel', ...receipt.revisions };
  const value = await requestSharedComposioAuthorization(options, flow, sharedComposioAuthorizationPath(flow, true), body);
  const status = parseSharedComposioAuthorizationSummary(value, flow);
  if (status.status === 'starting' || status.status === 'waiting' || status.status === 'callback_received') {
    throw new SharedComposioAuthorizationError('authorization_cancel_unconfirmed', 'Shared app cancellation is unconfirmed. Check this sign-in.');
  }
  options.onStatus?.(status); assertSharedComposioAuthorizationCurrent(options, flow);
  return status;
}

function sharedComposioAuthorizationPause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true });
  });
}

/** An explicit user resume first reads the same attempt; it never creates or re-links a provider account. */
export async function resumeSharedComposioAuthorization(flow: SharedComposioAuthorizationFlow,
  options: SharedComposioAuthorizationOptions): Promise<SharedComposioAuthorizationSummary> {
  const status = await readSharedComposioAuthorizationStatus(flow, options);
  const receipt = assertSharedComposioAuthorizationCurrent(options, flow);
  if (status.status === 'starting') return status;
  if (status.status === 'callback_received') {
    receipt.finalizeUnconfirmed = false;
    return finalizeSharedComposioAuthorization(flow, options);
  }
  if (status.status !== 'waiting') return status;
  await openSharedComposioAuthorizationBrowser(flow, options, true);
  return waitForSharedComposioAuthorization(flow, options);
}

/** Poll only confirmed flows; an unconfirmed start or mutation ACK requires an explicit user action. */
export async function waitForSharedComposioAuthorization(flow: SharedComposioAuthorizationFlow,
  options: SharedComposioAuthorizationOptions): Promise<SharedComposioAuthorizationSummary> {
  while (true) {
    const receipt = assertSharedComposioAuthorizationCurrent(options, flow);
    let status = await readSharedComposioAuthorizationStatus(flow, options);
    if (status.status === 'starting') throw new SharedComposioAuthorizationError('authorization_start_unconfirmed', 'The shared app start is unconfirmed. Check or cancel this sign-in.');
    if (status.status === 'callback_received') status = await finalizeSharedComposioAuthorization(flow, options);
    if (status.status !== 'waiting' && status.status !== 'callback_received') return status;
    const deadline = Date.parse(receipt.expiresAt!);
    if (deadline <= Date.now()) throw new SharedComposioAuthorizationError('authorization_expired', 'Shared app sign-in expired. Check its status.');
    await sharedComposioAuthorizationPause(options.signal, Math.min(2000, deadline - Date.now()));
  }
}
