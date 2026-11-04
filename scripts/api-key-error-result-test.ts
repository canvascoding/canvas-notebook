import assert from 'node:assert/strict';
import { ApiKeyAccessError } from '../app/lib/api-keys/contracts';
import { apiKeyDocumentFailureV1 } from '../app/lib/api-keys/error-result';

const failure = apiKeyDocumentFailureV1(new ApiKeyAccessError('API_KEY_RATE_LIMITED', 'PRIVATE_ERROR_MESSAGE', 429,
  { retryAfter: 12.25, credentialId: 'PRIVATE_CREDENTIAL_DETAILS' }));
assert.deepEqual(failure, { status: 429, body: { apiVersion: 1, success: false, code: 'API_KEY_RATE_LIMITED' }, retryAfter: '13' });
assert(Object.isFrozen(failure) && Object.isFrozen(failure.body));
assert(!JSON.stringify(failure).includes('PRIVATE'));
for (const [retryAfter, expected] of [[0.01, '1'], [999, '60'], [0, undefined], [-1, undefined],
  [NaN, undefined], [Infinity, undefined], ['invalid', undefined]] as const) {
  assert.equal(apiKeyDocumentFailureV1(new ApiKeyAccessError('API_KEY_RATE_LIMITED', 'private', 429, { retryAfter }))?.retryAfter, expected);
}
let getterCalls = 0;
const accessor = new ApiKeyAccessError('API_KEY_INVALID', 'private', 401);
Object.defineProperty(accessor, 'code', { get() { getterCalls++; throw new Error('Untrusted getter executed.'); } });
for (const value of [null, {}, { code: 'API_KEY_INVALID', status: 401 }, new Proxy(accessor, {}), accessor,
  new ApiKeyAccessError('UNAUTHORIZED', 'private', 401), new ApiKeyAccessError('API_KEY_INVALID', 'private', 200)]) {
  assert.equal(apiKeyDocumentFailureV1(value), null);
}
assert.equal(getterCalls, 0);
console.log('API-key failure DTO: bounded denial/retry data, no messages/details/getters, and no authentication claim passed.');
