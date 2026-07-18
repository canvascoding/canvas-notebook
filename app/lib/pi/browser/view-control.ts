import 'server-only';

import { getBrowserRuntimeContextKey, type BrowserRuntimeContext } from './runtime';
import type { BrowserViewControlMode } from './types';

const CONTROL_LEASE_MS = 30_000;

type BrowserControlState = {
  mode: BrowserViewControlMode;
  ownerViewId: string | null;
  leaseExpiresAt: number | null;
};

const controlStates = new Map<string, BrowserControlState>();

function runtimeKey(context: BrowserRuntimeContext): string {
  return getBrowserRuntimeContextKey(context);
}

function currentState(context: BrowserRuntimeContext, now = Date.now()): BrowserControlState {
  const key = runtimeKey(context);
  const state = controlStates.get(key) ?? { mode: 'agent', ownerViewId: null, leaseExpiresAt: null };
  if (state.mode === 'user' && state.leaseExpiresAt !== null && state.leaseExpiresAt <= now) {
    const expired = { mode: 'view', ownerViewId: null, leaseExpiresAt: null } satisfies BrowserControlState;
    controlStates.set(key, expired);
    return expired;
  }
  return state;
}

export function getBrowserControlState(context: BrowserRuntimeContext, now = Date.now()): BrowserControlState {
  return { ...currentState(context, now) };
}

export function setBrowserControlMode(input: {
  context: BrowserRuntimeContext;
  viewId: string;
  mode: BrowserViewControlMode;
  now?: number;
}): BrowserControlState {
  const now = input.now ?? Date.now();
  const current = currentState(input.context, now);
  if (current.mode === 'user' && current.ownerViewId !== input.viewId) {
    throw new Error('Another browser view currently owns user control.');
  }

  const next: BrowserControlState = input.mode === 'user'
    ? { mode: 'user', ownerViewId: input.viewId, leaseExpiresAt: now + CONTROL_LEASE_MS }
    : { mode: input.mode, ownerViewId: null, leaseExpiresAt: null };
  controlStates.set(runtimeKey(input.context), next);
  return { ...next };
}

export function refreshBrowserControlLease(
  context: BrowserRuntimeContext,
  viewId: string,
  now = Date.now(),
): BrowserControlState {
  const current = currentState(context, now);
  if (current.mode !== 'user' || current.ownerViewId !== viewId) return { ...current };
  const next = { ...current, leaseExpiresAt: now + CONTROL_LEASE_MS };
  controlStates.set(runtimeKey(context), next);
  return next;
}

export function releaseBrowserViewControl(context: BrowserRuntimeContext, viewId: string): void {
  const current = currentState(context);
  if (current.ownerViewId === viewId) {
    controlStates.set(runtimeKey(context), { mode: 'view', ownerViewId: null, leaseExpiresAt: null });
  }
}

export function assertBrowserUserControl(context: BrowserRuntimeContext, viewId: string): void {
  const state = currentState(context);
  if (state.mode !== 'user' || state.ownerViewId !== viewId) {
    throw new Error('Take over browser control before sending input.');
  }
}

export function assertAgentBrowserControl(context: BrowserRuntimeContext): void {
  const state = currentState(context);
  if (state.mode === 'user') {
    throw new Error('Browser control is currently owned by the user.');
  }
}
