import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyServerLoadFailure, ERROR_REASONS } from './connection-errors.mjs';

test('classifies common Chromium and network connection errors', () => {
  assert.equal(classifyServerLoadFailure('ERR_NAME_NOT_RESOLVED'), ERROR_REASONS.SERVER_NOT_FOUND);
  assert.equal(classifyServerLoadFailure(new Error('connect ECONNREFUSED 127.0.0.1:3000')), ERROR_REASONS.SERVER_UNAVAILABLE);
  assert.equal(classifyServerLoadFailure('ERR_CONNECTION_TIMED_OUT'), ERROR_REASONS.CONNECTION_TIMED_OUT);
  assert.equal(classifyServerLoadFailure('ERR_CERT_AUTHORITY_INVALID'), ERROR_REASONS.CERTIFICATE_ERROR);
  assert.equal(classifyServerLoadFailure('ERR_INTERNET_DISCONNECTED'), ERROR_REASONS.OFFLINE);
});

test('classifies a network error wrapped by fetch', () => {
  const dnsError = Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' });
  const fetchError = new TypeError('fetch failed', { cause: dnsError });

  assert.equal(classifyServerLoadFailure(fetchError), ERROR_REASONS.SERVER_NOT_FOUND);
});

test('uses a safe fallback for unexpected load errors', () => {
  assert.equal(classifyServerLoadFailure('unexpected internal error'), ERROR_REASONS.CONNECTION_FAILED);
});
