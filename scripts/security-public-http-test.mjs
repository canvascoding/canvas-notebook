import assert from 'node:assert/strict';

const origin = new URL(process.env.CANVAS_TEST_BASE_URL || 'http://localhost:3000');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname), 'This suite only targets a local test app.');
const request = (route, options = {}) => fetch(new URL(route, origin), { ...options, signal: AbortSignal.timeout(20_000) });
const oversized = await request('/api/setup/owner', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(17 * 1024) });
assert.ok([413, 429].includes(oversized.status), 'public setup must reject oversize input or an already exhausted quota');
await oversized.body?.cancel();
const guarded = [
  ['GET', '/api/files/list'], ['GET', '/api/files/read?path=fixture.txt'],
  ['POST', '/api/files/create'], ['DELETE', '/api/files/delete'], ['POST', '/api/files/html-pdf'],
  ['GET', '/api/integrations/env'], ['PUT', '/api/integrations/env'],
  ['GET', '/api/admin/knowledge-settings'], ['GET', '/api/agent-runtime/preferences'],
  ['POST', '/api/license/activate'], ['POST', '/api/license/register'],
  ['POST', '/api/license/claim/start'], ['POST', '/api/license/team/preflight'],
  ['POST', '/api/automations/execute'], ['POST', '/api/automations/scheduler/queue-due'],
  ['POST', '/api/automations/scheduler/execute-ready'],
];
let rejected = 0;
for (const credentials of [ {}, { cookie: 'better-auth.session_token=invented.signature' }, { authorization: 'Bearer invented-token' } ]) {
  for (const [method, route] of guarded) {
    const response = await request(route, {
      method, headers: { ...credentials, 'content-type': 'application/json', origin: origin.origin, 'x-canvas-internal-token': 'invented-token' },
      ...(method !== 'GET' ? { body: '{}' } : {}),
    });
    assert.ok([401, 403].includes(response.status), `${method} ${route}: expected rejection, received ${response.status}`);
    await response.body?.cancel();
    rejected++;
  }
}
const invalidShare = await request(`/public/markdown-pdf/${'A'.repeat(43)}`, { method: 'POST' });
assert.equal(invalidShare.status, 404, 'invalid share must fail before rendering');
await invalidShare.body?.cancel();
const invalidPreview = await request(`/api/mobile/v1/files/html-preview/${'A'.repeat(43)}/fixture.html`);
assert.equal(invalidPreview.status, 404);
await invalidPreview.body?.cancel();

let setupAdmitted = 0;
let setupBlocked = 0;
for (let i = 0; i < 12; i++) {
  const response = await request('/api/setup/owner', {
    method: 'POST', body: '{}', headers: {
      'content-type': 'application/json', cookie: `better-auth.session_token=invented-${i}`,
      'x-forwarded-for': `203.0.113.${i + 1}`, 'x-real-ip': `203.0.113.${i + 1}`,
      'x-canvas-proxy-client-ip': `203.0.113.${i + 1}`, 'x-canvas-proxy-token': '0'.repeat(64),
    },
  });
  if (response.status === 409) setupAdmitted++;
  else { assert.equal(response.status, 429); setupBlocked++; }
  await response.body?.cancel();
}
assert.ok(setupAdmitted <= 5 && setupBlocked >= 7, 'spoofed credentials must not renew public setup budgets');

let authenticated = false;
if (process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
  const signIn = await request('/api/auth/sign-in/email', {
    method: 'POST', headers: { origin: origin.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD }),
  });
  assert.equal(signIn.status, 200, 'local fixture login must succeed');
  const cookie = (signIn.headers.get('set-cookie') || '').split(';', 1)[0];
  const login = await signIn.json();
  assert.ok(cookie.includes('session_token='));
  try {
    let admitted = 0;
    for (let i = 0; i < 62; i++) {
      const response = await request('/api/files/list', { headers: { cookie } });
      if (response.status === 429) { await response.body?.cancel(); break; }
      assert.equal(response.status, 200, 'authenticated file access must remain available');
      admitted++;
      await response.body?.cancel();
    }
    assert.ok(admitted > 0 && admitted <= 60);
    const bearer = await request('/api/files/list', { headers: { authorization: `Bearer ${login.token}` } });
    assert.equal(bearer.status, 401, 'the web file route retains its cookie-only proxy policy');
    await bearer.body?.cancel();
    const secondLogin = await request('/api/auth/sign-in/email', {
      method: 'POST', headers: { origin: origin.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD }),
    });
    assert.equal(secondLogin.status, 200);
    const secondCookie = (secondLogin.headers.get('set-cookie') || '').split(';', 1)[0];
    await secondLogin.json();
    try {
      const sameUser = await request('/api/files/list', { headers: { cookie: secondCookie } });
      assert.equal(sameUser.status, 429, 'a new verified session must not renew the user budget');
      await sameUser.body?.cancel();
    } finally {
      await request('/api/auth/sign-out', { method: 'POST', headers: { origin: origin.origin, cookie: secondCookie, 'content-type': 'application/json' }, body: '{}' }).then(r => r.text());
    }
    authenticated = true;
  } finally {
    const signedOut = await request('/api/auth/sign-out', { method: 'POST', headers: { origin: origin.origin, cookie, 'content-type': 'application/json' }, body: '{}' });
    await signedOut.body?.cancel();
  }
}
console.log(JSON.stringify({ result: 'ok', rejectedProtectedRequests: rejected, invalidShareAndPreviewRejected: true, setupAdmitted, setupBlocked, authenticatedSessionRotationQuotaVerified: authenticated }));
