import { ownedRequestBudget, ownedRequestBudgetEnabled } from './owned-request-budget';

// The real create endpoint allows 20 requests per minute per authenticated user.
// These one-worker UI suites honor that budget across their synthetic workspaces.
const recentRequests: number[] = [];

export async function waitForFileCreateBudget(): Promise<void> {
  if (ownedRequestBudgetEnabled()) { await ownedRequestBudget.wait('files-create'); return; }
  const windowMs = 61_000;
  const discardExpired = () => {
    while (recentRequests.length && recentRequests[0] + windowMs <= Date.now()) recentRequests.shift();
  };
  discardExpired();
  while (recentRequests.length >= 19) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, recentRequests[0] + windowMs - Date.now())));
    discardExpired();
  }
  recentRequests.push(Date.now());
}
