import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { checkBrowserUrlPolicy } from '../app/lib/pi/browser/url-policy';
import {
  allowBrowserViewMessage,
  createBrowserViewRateLimitState,
} from '../app/lib/pi/browser/view-rate-limit';
import { issueBrowserFixtureTicket } from '../app/lib/pi/browser/view-fixture-ticket';
import {
  cleanupBrowserDownloadStagingFile,
  normalizeBrowserUploadPaths,
} from '../app/lib/pi/browser/view-transfers';
import { issueBrowserViewTicket, verifyBrowserViewTicket } from '../app/lib/pi/browser/view-ticket';

const LOAD_ITERATIONS = 20_000;
const LOAD_BUDGET_MS = 15_000;
const TEST_SECRET = 'browser-view-security-load-secret-at-least-32-chars';

function ticketInput(index = 0) {
  return {
    viewId: `view-${index}`,
    userId: 'security-user',
    authSessionId: 'security-auth-session',
    agentId: 'canvas-agent',
    agentSessionId: 'security-agent-session',
    workspaceId: 'security-workspace',
    workspaceType: 'personal',
    organizationId: null,
  };
}

async function testNavigationBoundary(): Promise<void> {
  const blockedUrls = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://10.0.0.1',
    'http://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'https://user:password@example.com',
  ];
  for (const url of blockedUrls) {
    const result = await checkBrowserUrlPolicy(url, { lookupDns: false });
    assert.equal(result.allowed, false, `${url} must be blocked`);
  }

  const metadataAllowlistAttempt = await checkBrowserUrlPolicy('http://169.254.169.254/latest/meta-data', {
    env: { CANVAS_BROWSER_ALLOWED_HOSTS: '169.254.169.254' } as unknown as NodeJS.ProcessEnv,
    lookupDns: false,
  });
  assert.equal(metadataAllowlistAttempt.allowed, false);

  const fixtureAccess = issueBrowserFixtureTicket('security-user');
  const fixtureUrl = `http://localhost:3000/api/browser/view/fixture-page?access=${encodeURIComponent(fixtureAccess)}`;
  const signedFixture = await checkBrowserUrlPolicy(fixtureUrl, {
    env: { ...process.env, PORT: '3000' },
    lookupDns: false,
  });
  assert.equal(signedFixture.allowed, true);
  assert.equal(signedFixture.category, 'signed-local-fixture');

  const wrongPath = await checkBrowserUrlPolicy(
    `http://localhost:3000/api/health?access=${encodeURIComponent(fixtureAccess)}`,
    { env: { ...process.env, PORT: '3000' }, lookupDns: false },
  );
  assert.equal(wrongPath.allowed, false);
  const wrongPort = await checkBrowserUrlPolicy(
    `http://localhost:3001/api/browser/view/fixture-page?access=${encodeURIComponent(fixtureAccess)}`,
    { env: { ...process.env, PORT: '3000' }, lookupDns: false },
  );
  assert.equal(wrongPort.allowed, false);
  const omittedPort = await checkBrowserUrlPolicy(
    `http://localhost/api/browser/view/fixture-page?access=${encodeURIComponent(fixtureAccess)}`,
    { env: { ...process.env, PORT: '3000' }, lookupDns: false },
  );
  assert.equal(omittedPort.allowed, false);
  const tamperedFixture = await checkBrowserUrlPolicy(`${fixtureUrl}x`, {
    env: { ...process.env, PORT: '3000' },
    lookupDns: false,
  });
  assert.equal(tamperedFixture.allowed, false);
}

function testTicketAndPathBoundaries(): void {
  const issued = issueBrowserViewTicket(ticketInput(), 1_000);
  assert.deepEqual(verifyBrowserViewTicket(issued.token, 2_000), issued.claims);
  assert.throws(() => verifyBrowserViewTicket(`${issued.token}x`, 2_000), /signature/u);
  assert.throws(() => verifyBrowserViewTicket(issued.token, issued.claims.expiresAt), /expired/u);
  assert.doesNotMatch(issued.token, new RegExp(TEST_SECRET, 'u'));

  assert.deepEqual(normalizeBrowserUploadPaths(['folder/report.txt'], false), ['folder/report.txt']);
  assert.throws(() => normalizeBrowserUploadPaths(['../secret.txt'], false));
  assert.throws(() => normalizeBrowserUploadPaths(['C:\\Windows\\secret.txt'], false));
  assert.throws(() => normalizeBrowserUploadPaths(Array.from({ length: 11 }, (_, index) => `${index}.txt`), true));
}

async function testRateLimits(): Promise<void> {
  const inputState = createBrowserViewRateLimitState(1_000);
  for (let index = 0; index < 120; index += 1) {
    assert.equal(allowBrowserViewMessage(inputState, true, 1_500), true);
  }
  assert.equal(allowBrowserViewMessage(inputState, true, 1_500), false);
  assert.equal(allowBrowserViewMessage(inputState, true, 2_000), true);

  const commandState = createBrowserViewRateLimitState(1_000);
  for (let index = 0; index < 60; index += 1) {
    assert.equal(allowBrowserViewMessage(commandState, false, 30_000), true);
  }
  assert.equal(allowBrowserViewMessage(commandState, false, 30_000), false);
  assert.equal(allowBrowserViewMessage(commandState, false, 61_000), true);

  await assert.rejects(
    cleanupBrowserDownloadStagingFile('/tmp/browser-view-staging-test', '../../outside'),
    /Invalid browser download scope/u,
  );
}

async function runLoadProbe(): Promise<{ ticketsMs: number; policiesMs: number; limiterMs: number }> {
  const now = Date.now();
  const ticketStart = performance.now();
  for (let index = 0; index < LOAD_ITERATIONS; index += 1) {
    const issued = issueBrowserViewTicket(ticketInput(index), now);
    const verified = verifyBrowserViewTicket(issued.token, now + 1);
    assert.equal(verified.viewId, `view-${index}`);
  }
  const ticketsMs = performance.now() - ticketStart;

  const policyStart = performance.now();
  for (let index = 0; index < LOAD_ITERATIONS; index += 1) {
    const result = await checkBrowserUrlPolicy(`https://example.com/path/${index}`, { lookupDns: false });
    assert.equal(result.allowed, true);
  }
  const policiesMs = performance.now() - policyStart;

  const limiterStart = performance.now();
  const limiter = createBrowserViewRateLimitState(now);
  for (let index = 0; index < LOAD_ITERATIONS * 10; index += 1) {
    allowBrowserViewMessage(limiter, true, now + (index % 500));
  }
  const limiterMs = performance.now() - limiterStart;

  assert.ok(ticketsMs < LOAD_BUDGET_MS, `Ticket load probe exceeded ${LOAD_BUDGET_MS}ms: ${ticketsMs}ms`);
  assert.ok(policiesMs < LOAD_BUDGET_MS, `URL policy load probe exceeded ${LOAD_BUDGET_MS}ms: ${policiesMs}ms`);
  assert.ok(limiterMs < LOAD_BUDGET_MS, `Rate-limit probe exceeded ${LOAD_BUDGET_MS}ms: ${limiterMs}ms`);
  return { ticketsMs, policiesMs, limiterMs };
}

async function main(): Promise<void> {
  const previousSecret = process.env.CANVAS_BROWSER_VIEW_TICKET_SECRET;
  process.env.CANVAS_BROWSER_VIEW_TICKET_SECRET = TEST_SECRET;
  try {
    await testNavigationBoundary();
    testTicketAndPathBoundaries();
    await testRateLimits();
    const timings = await runLoadProbe();
    console.log('browser-view-security-load-test: ok', {
      iterations: LOAD_ITERATIONS,
      ticketsMs: Math.round(timings.ticketsMs),
      policiesMs: Math.round(timings.policiesMs),
      limiterMs: Math.round(timings.limiterMs),
    });
  } finally {
    if (previousSecret === undefined) delete process.env.CANVAS_BROWSER_VIEW_TICKET_SECRET;
    else process.env.CANVAS_BROWSER_VIEW_TICKET_SECRET = previousSecret;
  }
}

void main();
