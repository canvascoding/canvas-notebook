import assert from 'node:assert/strict';

import {
  TEAM_LICENSE_ACCESS_PAUSED,
  translateLicenseFallbackSignInResponse,
} from '../app/lib/auth/license-fallback-login';

function signInRequest(email: unknown, path = '/api/auth/sign-in/email'): Request {
  return new Request(`https://notebook.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'test-password' }),
  });
}

async function main() {
  const genericBan = Response.json({ code: 'BANNED_USER', message: 'Generic ban' }, { status: 403 });
  const wrongPassword = Response.json({ code: 'INVALID_EMAIL_OR_PASSWORD' }, { status: 401 });
  let lookups = 0;
  const fallback = async (email: string) => {
    lookups++;
    assert.equal(email, 'member@example.test');
    return true;
  };

  assert.equal(await translateLicenseFallbackSignInResponse(
    signInRequest('member@example.test'), wrongPassword, fallback,
  ), wrongPassword);
  assert.equal(await translateLicenseFallbackSignInResponse(
    signInRequest('member@example.test', '/api/auth/sign-in/social'), genericBan, fallback,
  ), genericBan);
  assert.equal(await translateLicenseFallbackSignInResponse(
    signInRequest(null), genericBan, fallback,
  ), genericBan);
  assert.equal(lookups, 0);

  assert.equal(await translateLicenseFallbackSignInResponse(
    signInRequest('member@example.test'), genericBan, async () => false,
  ), genericBan);
  assert.equal(await translateLicenseFallbackSignInResponse(
    signInRequest('member@example.test'), genericBan, async () => { throw new Error('database unavailable'); },
  ), genericBan);
  const localized = await translateLicenseFallbackSignInResponse(
    signInRequest(' Member@Example.Test '), genericBan, fallback,
  );
  assert.equal(localized.status, 403);
  assert.equal(localized.headers.get('cache-control'), 'no-store');
  assert.equal((await localized.json() as { code: string }).code, TEAM_LICENSE_ACCESS_PAUSED);
  assert.equal(lookups, 1);

  console.info('team license login error specialization passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
