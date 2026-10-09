import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { request } from 'node:https';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Composio } from '@composio/client';
import { chromium } from '@playwright/test';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import { parseComposioNativeConsentOptions, validateComposioNativeCallback,
  type ComposioNativeConsentFlowEvidence, type ComposioNativeConsentStats } from './helpers/composio-native-consent-fixture';

type Control = { version: 1; nonce: string; origin: string; stats: ComposioNativeConsentStats; issued: ComposioNativeConsentFlowEvidence[] };

async function requestComposioNativeConsent(address: string, certificate: Buffer,
  init: { method?: 'GET' | 'POST' | 'HEAD'; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const url = new URL(address);
  assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, '127.0.0.1'); assert(url.port);
  return new Promise((resolve, reject) => {
    const req = request(url, { ca: certificate, method: init.method || 'GET', headers: init.headers }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length;
        if (bytes > 64 * 1024) { response.destroy(); reject(new Error('Owned HTTPS response exceeded its bound.')); return; }
        chunks.push(buffer);
      });
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => reject(new Error('Owned HTTPS response failed.')));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Owned HTTPS request timed out.')));
    req.on('error', () => reject(new Error('Owned HTTPS request failed.'))); req.end(init.body);
  });
}

/** Actual local SDK + HTTPS protocol only. Approve is issued by this fixture, so this is never OS-browser evidence. */
async function main() {
  const nonce = randomBytes(16).toString('hex'), token = randomBytes(32).toString('base64url');
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `canvas-composio-consent-${nonce}-`));
  await fs.chmod(root, 0o700); const rootProof = await fs.lstat(root);
  await fs.writeFile(path.join(root, '.owner'), nonce, { mode: 0o600, flag: 'wx' });
  let legacy: Awaited<ReturnType<typeof createComposioProviderFixture>> | undefined;
  let native: Awaited<ReturnType<typeof createComposioProviderFixture>> | undefined;
  let closed = false;
  try {
    const keyPath = path.join(root, 'own.key'), certificatePath = path.join(root, 'own.crt');
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certificatePath,
      '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 15_000 });
    await fs.chmod(keyPath, 0o600); await fs.chmod(certificatePath, 0o600);
    const tls = { key: await fs.readFile(keyPath), cert: await fs.readFile(certificatePath) };
    const options = { tls, controlToken: token, allowedCallbackOrigin: 'http://127.0.0.1:3001' as const, fixtureNonce: nonce, cleanAuthorizationAddress: true as const };
    for (const value of [{ ...options, controlToken: 'invalid' }, { ...options, cleanAuthorizationAddress: false },
      { ...options, allowedCallbackOrigin: 'https://foreign.example' }, { ...options, unknown: true }]) {
      assert.throws(() => parseComposioNativeConsentOptions(value));
    }
    const orgState = randomBytes(32).toString('base64url'), teamState = randomBytes(32).toString('base64url');
    for (const address of ['http://127.0.0.1:3001/api/composio/shared/desktop/callback',
      `http://127.0.0.1:3001/api/composio/shared/desktop/callback?flow=${orgState}&flow=${orgState}`,
      `http://127.0.0.1:3001/api/composio/shared/callback?flow=${orgState}`,
      `http://127.0.0.1:3001/api/composio/shared/desktop/callback?flow=${orgState}&returnPath=/settings`,
      `https://foreign.example/api/composio/shared/desktop/callback?flow=${orgState}`]) {
      assert.throws(() => validateComposioNativeCallback(address));
    }
    legacy = await createComposioProviderFixture(); assert.equal(Object.hasOwn(legacy, 'nativeConsent'), false);
    const oldClient = new Composio({ apiKey: 'own-protocol-key', baseURL: legacy.baseUrl, maxRetries: 0, timeout: 10_000 });
    const oldSession = await oldClient.toolRouter.session.create({ user_id: 'own-legacy-entity' }, { maxRetries: 0 });
    const oldLink = await oldClient.toolRouter.session.link(oldSession.session_id, { toolkit: 'canva', callback_url: 'https://legacy.fixture.invalid/callback' }, { maxRetries: 0 });
    assert.equal(new URL(oldLink.redirect_url).origin, 'https://fixture.example.test');
    assert.equal(legacy.accounts.get('own-legacy-entity')?.[0].status, 'INITIATED');
    assert.equal(legacy.completeOAuth(oldLink.connected_account_id), 'https://legacy.fixture.invalid/callback');
    assert.equal(legacy.accounts.get('own-legacy-entity')?.[0].status, 'ACTIVE');
    await legacy.close(); legacy = undefined;
    console.log('composio-native-consent: default SDK fixture and programmatic completion semantics unchanged PASS');

    native = await createComposioProviderFixture({ nativeConsent: options }); const consent = native.nativeConsent; assert(consent);
    const readinessStats = consent.readStats(), readinessFlows = consent.readFlow(), readinessAccounts = [...native.accounts.entries()];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ready = await requestComposioNativeConsent(`${consent.origin}/native-test-ready`, tls.cert);
      assert.equal(ready.status, 200); assert.equal(ready.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(ready.headers['cache-control'], 'no-store'); assert.equal(ready.headers['referrer-policy'], 'no-referrer');
      assert.equal(ready.headers['set-cookie'], undefined); assert.equal(ready.headers.location, undefined);
      assert.equal(ready.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      assert.match(ready.body, /<title>Local Composio test ready<\/title>/u); assert.match(ready.body, /<h1>Local Composio test ready<\/h1>/u);
      assert.match(ready.body, /HTTPS has been accepted in this browser\. Return to Codex/u);
      assert.doesNotMatch(ready.body, /<(?:script|form|input)\b/iu);
    }
    assert.equal((await requestComposioNativeConsent(`${consent.origin}/native-test-ready?unknown=true`, tls.cert)).status, 404);
    for (const method of ['HEAD', 'POST'] as const) {
      assert.equal((await requestComposioNativeConsent(`${consent.origin}/native-test-ready`, tls.cert, { method })).status, 404);
    }
    assert.deepEqual(consent.readStats(), readinessStats); assert.deepEqual(consent.readFlow(), readinessFlows);
    assert.deepEqual([...native.accounts.entries()], readinessAccounts);
    console.log('composio-native-consent: exact static HTTPS readiness, no query/method fallback or state mutation PASS');
    const client = new Composio({ apiKey: 'own-native-protocol-key', baseURL: native.baseUrl, maxRetries: 0, timeout: 10_000 });
    const orgSession = await client.toolRouter.session.create({ user_id: 'own-org-entity' }, { maxRetries: 0 });
    const orgCallback = `http://127.0.0.1:3001/api/composio/shared/desktop/callback?flow=${orgState}`;
    const org = await client.toolRouter.session.link(orgSession.session_id, { toolkit: 'canva', callback_url: orgCallback }, { maxRetries: 0 });
    const teamSession = await client.toolRouter.session.create({ user_id: 'own-team-entity' }, { maxRetries: 0 });
    const teamCallback = `http://127.0.0.1:3001/api/composio/shared/desktop/callback?flow=${teamState}`;
    const team = await client.toolRouter.session.link(teamSession.session_id, { toolkit: 'canva', callback_url: teamCallback }, { maxRetries: 0 });
    for (const entity of ['own-org-entity', 'own-team-entity']) {
      const accounts = await client.connectedAccounts.list({ user_ids: [entity] }, { maxRetries: 0 });
      assert.equal(accounts.items.filter(account => account.toolkit.slug === 'canva' && account.status === 'ACTIVE').length, 2);
      assert.equal(accounts.items.filter(account => account.toolkit.slug === 'slack' && account.status === 'ACTIVE').length, 1);
      assert.equal(accounts.items.filter(account => account.status === 'INITIATED').length, 1);
    }
    assert.throws(() => native!.completeOAuth(org.connected_account_id), /real HTTPS approval form/u);
    assert.equal((await fetch(consent.controlUrl, { signal: AbortSignal.timeout(10_000) })).status, 401);
    assert.equal((await fetch(consent.controlUrl, { headers: { Authorization: 'Bearer wrong' }, signal: AbortSignal.timeout(10_000) })).status, 401);
    const controlHeaders = { Authorization: `Bearer ${token}` }, flowHash = createHash('sha256').update(orgState).digest('hex');
    const controlResponse = await fetch(`${consent.controlUrl}?flowHash=${flowHash}`, { headers: controlHeaders, signal: AbortSignal.timeout(10_000) });
    assert.equal(controlResponse.status, 200); assert.equal(controlResponse.headers.get('cache-control'), 'no-store');
    const control = await controlResponse.json() as Control;
    assert.deepEqual(Object.keys(control).sort(), ['issued', 'nonce', 'origin', 'stats', 'version']);
    assert.equal(control.nonce, nonce); assert.equal(control.origin, consent.origin); assert.equal(control.issued.length, 1);
    assert.deepEqual(Object.keys(control.issued[0]).sort(), ['approvals', 'authorizationUrlHash', 'callbackRedirects', 'consents', 'denials', 'flowHash', 'pendingAccountHash', 'profileEntityHash', 'status', 'toolkit']);
    assert.equal(control.issued[0].pendingAccountHash, createHash('sha256').update(org.connected_account_id).digest('hex'));
    assert.equal(control.issued[0].profileEntityHash, createHash('sha256').update('own-org-entity').digest('hex'));
    assert.equal(control.issued[0].authorizationUrlHash, createHash('sha256').update(org.redirect_url).digest('hex'));
    assert.equal(control.issued[0].status, 'INITIATED');
    assert.doesNotMatch(JSON.stringify(control), new RegExp([token, orgState, org.connected_account_id, 'own-org-entity', 'own-native-protocol-key'].join('|'), 'u'));
    for (const query of ['?flowHash=invalid', `?flowHash=${flowHash}&flowHash=${flowHash}`, '?unknown=true']) {
      assert.equal((await fetch(consent.controlUrl + query, { headers: controlHeaders, signal: AbortSignal.timeout(10_000) })).status, 400);
    }
    assert.equal((await fetch(consent.controlUrl, { method: 'POST', headers: controlHeaders, body: '{}', signal: AbortSignal.timeout(10_000) })).status, 405);
    console.log('composio-native-consent: real SDK exact entities/decoy accounts, bearer/hash-only readonly control PASS');

    const orgPage = await requestComposioNativeConsent(org.redirect_url, tls.cert);
    assert.equal(orgPage.status, 200); assert.equal(orgPage.headers['cache-control'], 'no-store');
    assert.match(String(orgPage.headers['content-security-policy']), /frame-ancestors 'none'/u);
    assert.match(orgPage.body, /history\.replaceState/u); assert.match(orgPage.body, />Approve</u);
    assert(!orgPage.body.includes(orgState) && !orgPage.body.includes(org.connected_account_id));
    assert.equal(native.accounts.get('own-org-entity')?.find(account => account.id === org.connected_account_id)?.status, 'INITIATED');
    const orgForm = orgPage.body.match(/name="consent" value="([A-Za-z0-9_-]{43})"/u)?.[1]; assert(orgForm);
    // Replay the genuine fetched document and its CSP/policy on our own HTTP
    // origin. This measures browser form headers without TLS exceptions,
    // provider activation, Origin injection or native/system-browser claims.
    const observed: Array<{ origin: string | undefined; site: string | undefined; mode: string | undefined; destination: string | undefined; validForm: boolean }> = [];
    const probe = createServer(async (incoming, response) => {
      try {
        const address = new URL(incoming.url ?? '/', 'http://localhost');
        if (incoming.method === 'GET' && address.pathname === '/authorize'
          && (address.search === '' || address.search === '?policy=no-referrer')) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Security-Policy': String(orgPage.headers['content-security-policy']),
            'Referrer-Policy': address.search ? 'no-referrer' : String(orgPage.headers['referrer-policy']) });
          response.end(orgPage.body); return;
        }
        if (incoming.method === 'POST' && address.pathname === '/consent' && !address.search) {
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const chunk of incoming) {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.length;
            if (bytes > 4096) throw new Error('Owned browser policy probe exceeded its body bound.'); chunks.push(value);
          }
          const values = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          observed.push({ origin: incoming.headers.origin, site: incoming.headers['sec-fetch-site'] as string | undefined,
            mode: incoming.headers['sec-fetch-mode'] as string | undefined, destination: incoming.headers['sec-fetch-dest'] as string | undefined,
            validForm: values.size === 2 && values.getAll('consent').length === 1 && values.get('consent') === orgForm
              && values.getAll('decision').length === 1 && values.get('decision') === 'approve' });
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
          response.end('<!doctype html><html><body>Owned browser policy probe received.</body></html>'); return;
        }
        response.writeHead(404); response.end();
      } catch { response.writeHead(400); response.end(); }
    });
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address(); assert(address && typeof address !== 'string');
    const probeOrigin = `http://127.0.0.1:${address.port}`;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      for (const variant of ['no-referrer', 'fixture'] as const) {
        const context = await browser.newContext({ ignoreHTTPSErrors: false });
        try {
          const page = await context.newPage();
          await page.goto(`${probeOrigin}/authorize${variant === 'no-referrer' ? '?policy=no-referrer' : ''}`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
          const acknowledgement = page.waitForResponse(value => value.url() === `${probeOrigin}/consent` && value.request().method() === 'POST', { timeout: 10_000 });
          await page.getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 10_000 });
          assert.equal((await acknowledgement).status(), 200);
          await page.waitForURL(`${probeOrigin}/consent`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
          const actual = observed.at(-1); assert(actual);
          assert.deepEqual(actual, { origin: variant === 'no-referrer' ? 'null' : probeOrigin,
            site: 'same-origin', mode: 'navigate', destination: 'document', validForm: true });
        } finally { await context.close(); }
      }
      assert.equal(observed.length, 2);
    } finally {
      try { await browser?.close(); }
      finally { probe.closeAllConnections(); await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve())); }
    }
    assert.equal(orgPage.headers['referrer-policy'], 'same-origin');
    assert.equal(native.accounts.get('own-org-entity')?.find(account => account.id === org.connected_account_id)?.status, 'INITIATED');
    console.log('composio-native-consent: installed Chromium genuine form Origin null with no-referrer and exact origin with fixture same-origin; bounded HTTP causal probe only PASS');
    const form = new URLSearchParams({ consent: orgForm, decision: 'approve' }).toString();
    assert.equal((await requestComposioNativeConsent(`${consent.origin}/consent`, tls.cert, { method: 'POST', body: form,
      headers: { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 400);
    assert.equal((await requestComposioNativeConsent(`${consent.origin}/consent`, tls.cert, { method: 'POST', body: form,
      headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 400);
    assert.equal(native.accounts.get('own-org-entity')?.find(account => account.id === org.connected_account_id)?.status, 'INITIATED');
    const approval = await requestComposioNativeConsent(`${consent.origin}/consent`, tls.cert, { method: 'POST', body: form,
      headers: { Origin: consent.origin, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(approval.status, 303); assert.equal(approval.headers.location, orgCallback); assert.equal(approval.headers['referrer-policy'], 'no-referrer');
    assert.equal(native.accounts.get('own-org-entity')?.find(account => account.id === org.connected_account_id)?.status, 'ACTIVE');
    assert.equal((await requestComposioNativeConsent(`${consent.origin}/consent`, tls.cert, { method: 'POST', body: form,
      headers: { Origin: consent.origin, 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 400);
    const teamPage = await requestComposioNativeConsent(team.redirect_url, tls.cert), teamForm = teamPage.body.match(/name="consent" value="([A-Za-z0-9_-]{43})"/u)?.[1]; assert(teamForm);
    const denial = await requestComposioNativeConsent(`${consent.origin}/consent`, tls.cert, { method: 'POST',
      body: new URLSearchParams({ consent: teamForm, decision: 'deny' }).toString(), headers: { Origin: consent.origin, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(denial.status, 303); const deniedCallback = new URL(denial.headers.location!);
    assert.equal(deniedCallback.searchParams.get('flow'), teamState); assert.equal(deniedCallback.searchParams.get('error'), 'access_denied');
    assert.equal(native.accounts.get('own-team-entity')?.find(account => account.id === team.connected_account_id)?.status, 'FAILED');
    const actual = await client.connectedAccounts.list({ user_ids: ['own-org-entity'] }, { maxRetries: 0 });
    assert.equal(actual.items.find(account => account.id === org.connected_account_id)?.status, 'ACTIVE');
    assert.equal(actual.items.filter(account => account.status === 'ACTIVE' && account.toolkit.slug === 'canva').length, 3);
    const after = await (await fetch(consent.controlUrl, { headers: controlHeaders, signal: AbortSignal.timeout(10_000) })).json() as Control;
    assert.equal(after.stats.sdkLinks, 2); assert.equal(after.stats.sessions, 2); assert.equal(after.stats.issued, 2);
    assert.equal(after.stats.consents, 2); assert.equal(after.stats.approvals, 1); assert.equal(after.stats.denials, 1);
    assert.equal(after.stats.callbackRedirects, 2); assert.equal(after.stats.businessCalls, 0);
    assert.equal(after.issued.find(value => value.flowHash === flowHash)?.approvals, 1);
    console.log('composio-native-consent: actual strict-CA HTTPS GET/Approve/deny/303, single-use form and ACTIVE exact account PASS');
    await native.close(); native = undefined; closed = true;
  } finally {
    if (legacy) await legacy.close(); if (native) await native.close();
    if (!legacy && !native || closed) {
      const current = await fs.lstat(root);
      assert(current.isDirectory() && !current.isSymbolicLink() && current.uid === process.getuid?.() && (current.mode & 0o777) === 0o700);
      assert.equal(current.dev, rootProof.dev); assert.equal(current.ino, rootProof.ino); assert.equal(await fs.realpath(root), root);
      assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), nonce); await fs.rm(root, { recursive: true });
    }
  }
}

void main().catch(() => { console.error('The owned local Composio consent protocol test failed.'); process.exitCode = 1; });
