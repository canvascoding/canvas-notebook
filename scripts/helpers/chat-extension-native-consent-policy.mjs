import assert from 'node:assert/strict';

/** Test-only opt-in: only the owned personal Composio callback may return to the dev app. */
export function nativePageConsentReturnSource(callback, toolkit, nativeReturnScheme) {
  assert(nativeReturnScheme === undefined || nativeReturnScheme === 'canvasnotebook-dev');
  if (nativeReturnScheme === undefined || !['github', 'slack'].includes(toolkit)) return '';
  const target = new URL(callback);
  assert.equal(target.origin, 'http://127.0.0.1:3001');
  assert.equal(target.pathname, '/api/composio/callback');
  assert(!target.username && !target.password && !target.hash);
  const values = [...target.searchParams];
  assert.equal(values.length, 1); assert.equal(values[0][0], 'flow'); assert.match(values[0][1], /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(target.href, `http://127.0.0.1:3001/api/composio/callback?flow=${values[0][1]}`);
  return ' canvasnotebook-dev:';
}
