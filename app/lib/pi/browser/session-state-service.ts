import 'server-only';

import {
  getBrowserRuntimeContextKey,
  getStatusDetails,
  type BrowserRuntimeContext,
} from './runtime';
import { publishBrowserSessionSnapshot } from './session-state';
import { getBrowserControlState } from './view-control';
import type { BrowserSessionSnapshot } from './types';

export async function refreshBrowserSessionSnapshot(
  context: BrowserRuntimeContext,
): Promise<BrowserSessionSnapshot> {
  const status = await getStatusDetails(context);
  const control = getBrowserControlState(context);
  return publishBrowserSessionSnapshot(getBrowserRuntimeContextKey(context), {
    running: status.running,
    controlMode: control.mode,
    interactionPolicy: control.interactionPolicy,
    interactionRevision: control.interactionRevision,
    lastUserInteractionAt: control.lastUserInteractionAt
      ? new Date(control.lastUserInteractionAt).toISOString()
      : null,
    activeTabId: status.activeTabId ?? null,
    activeTitle: status.activeTitle ?? null,
    activeUrl: status.activeUrl ?? null,
    tabCount: status.tabs?.length ?? 0,
    tabs: status.tabs ?? [],
    hasPendingDialog: Boolean(status.pendingDialog),
  });
}
