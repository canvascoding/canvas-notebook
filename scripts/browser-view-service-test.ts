import assert from 'node:assert/strict';

import {
  assertAgentBrowserControl,
  assertBrowserUserControl,
  getBrowserControlState,
  refreshBrowserControlLease,
  releaseBrowserViewControl,
  setBrowserControlMode,
} from '../app/lib/pi/browser/view-control';
import { resolveBrowserViewResourceBudget } from '../app/lib/pi/browser/view-resource-budget';
import { browserViewFailure } from '../app/lib/pi/browser/view-errors';
import { issueBrowserFixtureTicket, verifyBrowserFixtureTicket } from '../app/lib/pi/browser/view-fixture-ticket';
import {
  getBrowserSessionSnapshot,
  publishBrowserSessionSnapshot,
  sanitizeBrowserSessionUrl,
  subscribeBrowserSessionSnapshot,
} from '../app/lib/pi/browser/session-state';
import {
  normalizeBrowserUploadPaths,
  sanitizeBrowserDownloadFileName,
} from '../app/lib/pi/browser/view-transfers';
import { issueBrowserViewTicket, verifyBrowserViewTicket } from '../app/lib/pi/browser/view-ticket';

function ticketInput() {
  return {
    viewId: 'view-1',
    userId: 'user-1',
    authSessionId: 'auth-session-1',
    agentId: 'agent-1',
    agentSessionId: 'agent-session-1',
    workspaceId: 'workspace-1',
    workspaceType: 'personal',
    organizationId: null,
  };
}

function testTickets() {
  const issued = issueBrowserViewTicket(ticketInput(), 1_000);
  assert.deepEqual(verifyBrowserViewTicket(issued.token, 2_000), issued.claims);
  assert.throws(() => verifyBrowserViewTicket(`${issued.token}x`, 2_000), /signature/u);
  assert.throws(() => verifyBrowserViewTicket(issued.token, issued.claims.expiresAt), /expired/u);
}

function testFixtureTickets() {
  const token = issueBrowserFixtureTicket('user-1', 1_000);
  assert.equal(verifyBrowserFixtureTicket(token, 2_000).userId, 'user-1');
  assert.throws(() => verifyBrowserFixtureTicket(`${token}x`, 2_000), /signature/u);
  assert.throws(() => verifyBrowserFixtureTicket(token, 301_000), /expired/u);
}

function testExclusiveControl() {
  const context = {
    userId: 'view-user',
    agentId: 'view-agent',
    sessionId: `view-session-${Date.now()}`,
    workspaceId: 'view-workspace',
  };
  const now = Date.now();
  assert.equal(getBrowserControlState(context).mode, 'agent');

  const owned = setBrowserControlMode({ context, viewId: 'view-a', mode: 'user', now });
  assert.equal(owned.ownerViewId, 'view-a');
  assert.equal(owned.leaseExpiresAt, now + 30_000);
  assert.doesNotThrow(() => assertBrowserUserControl(context, 'view-a'));
  assert.throws(() => assertAgentBrowserControl(context), /owned by the user/u);
  assert.throws(
    () => setBrowserControlMode({ context, viewId: 'view-b', mode: 'agent', now: now + 1_000 }),
    /Another browser view/u,
  );

  const refreshed = refreshBrowserControlLease(context, 'view-a', now + 10_000);
  assert.equal(refreshed.leaseExpiresAt, now + 40_000);
  releaseBrowserViewControl(context, 'view-a');
  assert.equal(getBrowserControlState(context).mode, 'view');
  assert.doesNotThrow(() => assertAgentBrowserControl(context));
  assert.throws(() => assertBrowserUserControl(context, 'view-a'), /Take over/u);

  setBrowserControlMode({ context, viewId: 'view-a', mode: 'user', now: now + 50_000 });
  assert.equal(getBrowserControlState(context, now + 80_001).mode, 'view');
}

function testSafeFailures() {
  assert.deepEqual(
    browserViewFailure(new Error('Browser view ticket expired.'), 'subscribe'),
    {
      code: 'TICKET_EXPIRED',
      error: 'The browser view ticket expired.',
      retryable: true,
      fatal: true,
    },
  );
  assert.equal(
    browserViewFailure(new Error('Blocked cloud metadata endpoint.'), 'navigate').code,
    'NAVIGATION_BLOCKED',
  );
  assert.equal(
    browserViewFailure(new Error('net::ERR_NAME_NOT_RESOLVED'), 'navigate').code,
    'NAVIGATION_FAILED',
  );
  assert.equal(
    browserViewFailure(new Error('Protocol error (Page.captureScreenshot): Target closed'), 'capture').code,
    'PAGE_CRASHED',
  );
  const secretFailure = browserViewFailure(new Error('provider token sk-secret-value rejected request'));
  assert.equal(secretFailure.code, 'OPERATION_FAILED');
  assert.doesNotMatch(secretFailure.error, /secret-value/u);
}

function testSafeTransfers() {
  assert.equal(sanitizeBrowserDownloadFileName('../../private/report.pdf'), 'report.pdf');
  assert.equal(sanitizeBrowserDownloadFileName('..'), 'download.bin');
  assert.equal(sanitizeBrowserDownloadFileName('invoice\u0000?.pdf'), 'invoice-.pdf');
  assert.deepEqual(normalizeBrowserUploadPaths(['notes/report.pdf'], false), ['notes/report.pdf']);
  assert.throws(() => normalizeBrowserUploadPaths(['/etc/passwd'], false));
  assert.throws(() => normalizeBrowserUploadPaths(['notes/../secret.txt'], false));
  assert.throws(() => normalizeBrowserUploadPaths(['one.txt', 'two.txt'], false));
}

function testCompactBrowserSessionState() {
  assert.equal(
    sanitizeBrowserSessionUrl('https://user:password@example.test/account?token=secret#private'),
    'https://example.test/account',
  );
  assert.equal(sanitizeBrowserSessionUrl('javascript:alert(1)'), null);

  const contextKey = `browser-session-state-${Date.now()}`;
  const revisions: number[] = [];
  const unsubscribe = subscribeBrowserSessionSnapshot(contextKey, (snapshot) => {
    revisions.push(snapshot.revision);
  });
  const tabs = Array.from({ length: 14 }, (_, index) => ({
    id: `tab-${index + 1}`,
    title: `Tab ${index + 1}`,
    url: `https://example.test/page-${index + 1}?token=secret#private`,
    active: index === 13,
  }));
  const first = publishBrowserSessionSnapshot(contextKey, {
    running: true,
    controlMode: 'user',
    activeTabId: 'tab-14',
    activeTitle: 'Sensitive title',
    activeUrl: 'https://example.test/page-14?token=secret',
    tabCount: tabs.length,
    tabs,
    hasPendingDialog: true,
  });
  assert.equal(first.revision, 1);
  assert.equal(first.tabCount, 14);
  assert.equal(first.tabs.length, 12);
  assert.equal(first.tabs[0]?.id, 'tab-14');
  assert.equal(first.activeUrl, 'https://example.test/page-14');
  assert.equal(first.controlMode, 'user');
  assert.equal(first.hasPendingDialog, true);
  assert.deepEqual(revisions, [1]);

  const unchanged = publishBrowserSessionSnapshot(contextKey, {
    running: true,
    controlMode: 'user',
    activeTabId: 'tab-14',
    activeTitle: 'Sensitive title',
    activeUrl: 'https://example.test/page-14?different=secret',
    tabCount: tabs.length,
    tabs,
    hasPendingDialog: true,
  });
  assert.equal(unchanged.revision, 1);
  assert.deepEqual(revisions, [1]);

  const closed = publishBrowserSessionSnapshot(contextKey, {
    running: false,
    controlMode: 'view',
    activeTabId: 'tab-14',
    activeTitle: 'Ignored',
    activeUrl: 'https://example.test',
    tabCount: 14,
    tabs,
    hasPendingDialog: true,
  });
  assert.equal(closed.revision, 2);
  assert.equal(closed.running, false);
  assert.deepEqual(closed.tabs, []);
  assert.equal(getBrowserSessionSnapshot(contextKey)?.running, false);
  assert.deepEqual(revisions, [1, 2]);
  unsubscribe();
}

async function testResourceBudget() {
  const budget = await resolveBrowserViewResourceBudget();
  assert.ok(budget.effectiveMemoryMb > 0);
  assert.ok(budget.availableMemoryMb >= 0);
  assert.ok(budget.fps >= 2 && budget.fps <= 8);
  assert.ok(budget.maxConcurrentViews >= 1);
  assert.ok(budget.viewport.width <= 1280);
}

async function main() {
  const previousSecret = process.env.CANVAS_BROWSER_VIEW_TICKET_SECRET;
  process.env.CANVAS_BROWSER_VIEW_TICKET_SECRET = 'browser-view-test-secret-at-least-32-characters';
  try {
    testTickets();
    testFixtureTickets();
    testExclusiveControl();
    testSafeFailures();
    testSafeTransfers();
    testCompactBrowserSessionState();
    await testResourceBudget();
  } finally {
    if (previousSecret === undefined) delete process.env.CANVAS_BROWSER_VIEW_TICKET_SECRET;
    else process.env.CANVAS_BROWSER_VIEW_TICKET_SECRET = previousSecret;
  }
  console.log('browser view service tests passed');
}

void main();
