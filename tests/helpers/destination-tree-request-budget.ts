import assert from 'node:assert/strict';
import type { BrowserContext } from '@playwright/test';
import { ownedRequestBudget, ownedRequestBudgetEnabled } from './owned-request-budget';

const recent: number[] = [];
let queue = Promise.resolve();
const windowMs = 61_000;

/** Direct API tree reads are not intercepted by BrowserContext.route. */
export async function waitForDestinationFileTreeBudget(): Promise<void> {
  if (ownedRequestBudgetEnabled()) { await ownedRequestBudget.wait('files-tree'); return; }
  const pending = queue.then(async () => {
    while (true) {
      const now = Date.now();
      while (recent.length && recent[0] + windowMs <= now) recent.shift();
      if (recent.length < 59) { recent.push(now); return; }
      await new Promise(resolve => setTimeout(resolve, Math.max(1, recent[0] + windowMs - now)));
    }
  });
  queue = pending.catch(() => undefined);
  return pending;
}

/** Only Destination uses this hook. Quiet time precedes navigation/UI waits.
 * Earlier suites' unobserved tree usage starts conservatively full; subsequent
 * cases wait until every recorded request has aged out before opening a page. */
export async function prepareDestinationTreeRequestBudget(context: BrowserContext): Promise<void> {
  assert.equal(context.pages().length, 0, 'Tree budget preflight requires no Notebook page.');
  if (ownedRequestBudgetEnabled()) await ownedRequestBudget.quiet('files-tree');
  else if (recent.length) await new Promise(resolve => setTimeout(resolve, Math.max(0, recent.at(-1)! + windowMs - Date.now())));
  assert.equal(context.pages().length, 0, 'Tree budget preflight cannot open a Notebook page.');
  await context.route(url => url.pathname === '/api/files/tree', async route => {
    if (route.request().method() === 'GET') await waitForDestinationFileTreeBudget();
    await route.continue();
  });
}
