import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext } from '@playwright/test';

import { ownedCollaborationQaEnabled } from '../../scripts/lib/owned-collaboration-qa';
import { createAuthenticatedContext } from './managed-test-context';
import { waitForOwnedNotificationSummaryBudget } from './notification-summary-budget';
import { requireOwnedQaAgentToolSocket } from './ordinary-agent-tool';
import { withOwnedTestCleanup } from './owned-test-cleanup';

/** Reset inherited request budgets through real idle time, never by changing server limits. */
export async function waitForOwnedSuiteRequestBudget(browser: Browser): Promise<void> {
  if (!ownedCollaborationQaEnabled()) return;
  const socketPath = process.env.CANVAS_LOCAL_AGENT_TOOL_SOCKET;
  if (!socketPath) throw new Error('Owned suite request preflight requires its current QA source socket.');
  await requireOwnedQaAgentToolSocket(socketPath);
  const receiptPath = path.join(path.dirname(socketPath), 'host-binding.json');
  const sourceReceipt = await readFile(receiptPath);
  if (browser.contexts().some(context => context.pages().length > 0)) {
    throw new Error('Owned suite request preflight requires all Notebook pages to be closed.');
  }
  let context: BrowserContext | undefined;
  await withOwnedTestCleanup(async () => {
    // Authentication completes before the quiet window, with no page or polling consumer open.
    context = await createAuthenticatedContext(browser);
    if (browser.contexts().some(context => context.pages().length > 0)) {
      throw new Error('Owned suite request preflight opened an unexpected Notebook page.');
    }
    await waitForOwnedNotificationSummaryBudget(context.request);
    if (browser.contexts().some(context => context.pages().length > 0)) {
      throw new Error('Owned suite request preflight opened a Notebook page during the quiet window.');
    }
    await requireOwnedQaAgentToolSocket(socketPath);
    if (!sourceReceipt.equals(await readFile(receiptPath))) {
      throw new Error('Owned suite request preflight source changed during the quiet window.');
    }
  }, [
    { label: 'suite request preflight context', run: async () => { await context?.close(); } },
    { label: 'suite request preflight context removal', run: () => {
      if (context && browser.contexts().includes(context)) throw new Error('Preflight context remains open.');
    } },
  ]);
}
