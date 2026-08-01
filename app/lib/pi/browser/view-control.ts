import 'server-only';

import { getBrowserRuntimeContextKey, type BrowserRuntimeContext } from './runtime';
import type { BrowserInteractionPolicy, BrowserViewControlMode } from './types';

const CONTROL_LEASE_MS = 30_000;

type BrowserControlState = {
  mode: BrowserViewControlMode;
  interactionPolicy: BrowserInteractionPolicy;
  interactionRevision: number;
  lastUserInteractionAt: number | null;
  ownerViewId: string | null;
  leaseExpiresAt: number | null;
};

const controlStates = new Map<string, BrowserControlState>();

function runtimeKey(context: BrowserRuntimeContext): string {
  return getBrowserRuntimeContextKey(context);
}

function currentState(context: BrowserRuntimeContext, now = Date.now()): BrowserControlState {
  const key = runtimeKey(context);
  const state = controlStates.get(key) ?? {
    mode: 'agent',
    interactionPolicy: 'exclusive',
    interactionRevision: 0,
    lastUserInteractionAt: null,
    ownerViewId: null,
    leaseExpiresAt: null,
  };
  if (state.mode === 'user' && state.leaseExpiresAt !== null && state.leaseExpiresAt <= now) {
    const expired = {
      ...state,
      mode: 'view',
      ownerViewId: null,
      leaseExpiresAt: null,
    } satisfies BrowserControlState;
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
  interactionPolicy?: BrowserInteractionPolicy;
  now?: number;
}): BrowserControlState {
  const now = input.now ?? Date.now();
  const current = currentState(input.context, now);
  if (current.mode === 'user' && current.ownerViewId !== input.viewId) {
    throw new Error('Another browser view currently owns user control.');
  }

  const interactionPolicy = input.interactionPolicy ?? current.interactionPolicy;
  const next: BrowserControlState = input.mode === 'user'
    ? {
        ...current,
        mode: 'user',
        interactionPolicy,
        ownerViewId: input.viewId,
        leaseExpiresAt: now + CONTROL_LEASE_MS,
      }
    : {
        ...current,
        mode: input.mode,
        interactionPolicy,
        ownerViewId: null,
        leaseExpiresAt: null,
      };
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
    controlStates.set(runtimeKey(context), {
      ...current,
      mode: 'view',
      ownerViewId: null,
      leaseExpiresAt: null,
    });
  }
}

export function recordBrowserUserInteraction(
  context: BrowserRuntimeContext,
  viewId: string,
  now = Date.now(),
): BrowserControlState {
  const current = currentState(context, now);
  if (current.mode !== 'user' || current.ownerViewId !== viewId) {
    throw new Error('Take over browser control before sending input.');
  }
  const next: BrowserControlState = {
    ...current,
    interactionRevision: current.interactionRevision + 1,
    lastUserInteractionAt: now,
    leaseExpiresAt: now + CONTROL_LEASE_MS,
  };
  controlStates.set(runtimeKey(context), next);
  return { ...next };
}

export function assertBrowserUserControl(context: BrowserRuntimeContext, viewId: string): void {
  const state = currentState(context);
  if (state.mode !== 'user' || state.ownerViewId !== viewId) {
    throw new Error('Take over browser control before sending input.');
  }
}

export function assertAgentBrowserControl(context: BrowserRuntimeContext): void {
  const state = currentState(context);
  if (state.mode === 'user' && state.interactionPolicy === 'exclusive') {
    throw new Error('Browser control is currently owned by the user.');
  }
}

export function shouldAbortAgentForBrowserControl(
  interactionPolicy: BrowserInteractionPolicy,
): boolean {
  return interactionPolicy === 'exclusive';
}
