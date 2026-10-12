import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { startMcpOAuthProvider } from '../tests/fixtures/mcp-oauth-provider.mjs';

async function exerciseConsent(cleanAuthorizationAddress, native = {}) {
  const callbackOrigin = 'http://127.0.0.1:3001';
  const provider = await startMcpOAuthProvider({ allowedRedirectOrigins: [callbackOrigin], cleanAuthorizationAddress,
    ...(native.scheme === undefined ? {} : { nativeReturnScheme: native.scheme }) });
  try {
    const callbackPath = native.callbackPath ?? '/api/mcp/oauth/callback';
    const redirectUri = `${callbackOrigin}${callbackPath}${native.callbackSearch ?? ''}`;
    const registration = await fetch(`${provider.origin}/register`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirectUri] }) });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    const state = `${native.statePrefix ?? 'desktop_'}${randomBytes(24).toString('base64url')}`;
    const verifier = randomBytes(48).toString('base64url');
    const authorize = new URL('/authorize', provider.origin);
    authorize.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      response_type: 'code', resource: provider.url }).toString();
    const response = await fetch(authorize);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const html = await response.text();
    assert.equal(html.includes(state), false); assert.equal(html.includes(authorize.toString()), false);
    const csp = response.headers.get('content-security-policy');
    assert(csp.includes(`default-src 'none'; form-action 'self' ${callbackOrigin}`));
    const allowsNative = native.scheme === 'canvasnotebook-dev' && callbackPath === '/api/mcp/oauth/callback'
      && !native.callbackSearch && (native.statePrefix === undefined || native.statePrefix === 'desktop_');
    assert.equal(csp.split(';')[1], ` form-action 'self' ${callbackOrigin}${allowsNative ? ' canvasnotebook-dev:' : ''}`,
      'Only the explicit native fixture and exact registered callback may permit the final custom-scheme hop.');
    assert(csp.includes("frame-ancestors 'none'; base-uri 'none'"));
    if (cleanAuthorizationAddress) {
      const script = html.match(/<script nonce="([A-Za-z0-9_-]{32})">([^<]+)<\/script>/u);
      assert(script); assert.equal(script[2], "history.replaceState(null,'',location.pathname)");
      assert.equal(csp.split('; script-src ')[1], `'nonce-${script[1]}'`);
      assert.equal((html.match(/<script/gu) ?? []).length, 1);
    } else { assert.equal(html.includes('<script'), false); assert.equal(csp.includes('script-src'), false); }
    const consent = html.match(/name="consent" value="([A-Za-z0-9_-]+)"/u)?.[1];
    assert(consent);
    const approved = await fetch(`${provider.origin}/consent`, { method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ consent, decision: 'approve' }) });
    assert.equal(approved.status, 303);
    const callback = new URL(approved.headers.get('location'));
    assert.equal(callback.origin, callbackOrigin); assert.equal(callback.pathname, callbackPath);
    assert.equal(callback.searchParams.get('state'), state); assert.equal(callback.searchParams.get('iss'), provider.origin);
    const code = callback.searchParams.get('code'); assert(code);
    const token = await fetch(`${provider.origin}/token`, { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: redirectUri,
      code_verifier: verifier, resource: provider.url }) });
    assert.equal(token.status, 200);
    assert.equal((await token.json()).token_type, 'Bearer');
    assert.equal(provider.stats.consents, 1); assert.equal(provider.stats.approvals, 1);
    assert.equal(provider.stats.tokenExchanges, 1); assert.equal(provider.stats.mcpInitializations, 0);
    assert.equal(provider.stats.toolsLists, 0); assert.equal(provider.stats.toolCalls, 0);
  } finally { await provider.close(); }
}

async function main() {
  await assert.rejects(startMcpOAuthProvider({ cleanAuthorizationAddress: 'true' }));
  await exerciseConsent(false); await exerciseConsent(true);
  await exerciseConsent(true, { scheme: 'canvasnotebook-dev' });
  for (const scheme of [true, 'canvasnotebook', 'canvasnotebook-dev:', 'javascript', 'canvasnotebook-dev; script-src *']) {
    await assert.rejects(startMcpOAuthProvider({ nativeReturnScheme: scheme }));
  }
  for (const origins of [undefined, [], ['http://127.0.0.1:3001', 'http://127.0.0.1:3002'], ['https://foreign.example']]) {
    await assert.rejects(startMcpOAuthProvider({ nativeReturnScheme: 'canvasnotebook-dev', allowedRedirectOrigins: origins }));
  }
  await exerciseConsent(true, { scheme: 'canvasnotebook-dev', callbackPath: '/other/callback' });
  await exerciseConsent(true, { scheme: 'canvasnotebook-dev', callbackSearch: '?unexpected=1' });
  await exerciseConsent(true, { scheme: 'canvasnotebook-dev', statePrefix: 'browser_' });
  console.info('OWN_NATIVE_PROVIDER_PROTOCOL_PASS default/clean-address/native-scheme; exact callback-only CSP; unchanged PKCE exchange; no business calls');
}

main().catch(error => {
  const site = error instanceof Error ? error.stack?.match(/mcp-oauth-native-provider-test\.mjs:\d+:\d+/u)?.[0] : undefined;
  console.error('OWN_NATIVE_PROVIDER_PROTOCOL_FAIL', error instanceof assert.AssertionError ? 'assertion' : 'unexpected', site ?? 'unknown');
  process.exitCode = 1;
});
