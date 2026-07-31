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
  return publishBrowserSessionSnapshot(getBrowserRuntimeContextKey(context), {
    running: status.running,
    controlMode: getBrowserControlState(context).mode,
    activeTabId: status.activeTabId ?? null,
    activeTitle: status.activeTitle ?? null,
    activeUrl: status.activeUrl ?? null,
    tabCount: status.tabs?.length ?? 0,
    tabs: status.tabs ?? [],
    hasPendingDialog: Boolean(status.pendingDialog),
  });
}
