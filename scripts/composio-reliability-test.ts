import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { classifyComposioFailure, retryAfterMs } from '../app/lib/composio/composio-provider-error';

async function main() {
  const timeout = classifyComposioFailure({ error: new DOMException('Timed out', 'AbortError'), mutation: true, timeout: true });
  assert.equal(timeout.code, 'COMPOSIO_OUTCOME_UNKNOWN');
  assert.equal(timeout.outcomeUnknown, true);
  assert.equal(timeout.retryable, false);

  const scope = classifyComposioFailure({ status: 403 });
  assert.equal(scope.code, 'COMPOSIO_CREDENTIALS_OR_SCOPE');
  assert.equal(scope.retryable, false);

  const rateLimit = classifyComposioFailure({ status: 429, headers: new Headers({ 'retry-after': '2', 'x-request-id': 'request-1' }) });
  assert.equal(rateLimit.code, 'COMPOSIO_RATE_LIMITED');
  assert.equal(rateLimit.retryable, true);
  assert.equal(rateLimit.providerRequestId, 'request-1');
  assert.equal(retryAfterMs('3'), 3000);

  const controlPlaneOutcome = classifyComposioFailure({
    status: 502,
    payload: { error: 'Timed out', code: 'COMPOSIO_OUTCOME_UNKNOWN', outcomeUnknown: true, retryable: true, providerRequestId: 'provider-1', retryAfterMs: 1000 },
  });
  assert.equal(controlPlaneOutcome.code, 'COMPOSIO_OUTCOME_UNKNOWN');
  assert.equal(controlPlaneOutcome.outcomeUnknown, true);
  assert.equal(controlPlaneOutcome.retryable, false);
  assert.equal(controlPlaneOutcome.providerRequestId, 'provider-1');

  const sdkScopeError = classifyComposioFailure({
    error: { response: { status: 403, headers: { 'x-request-id': 'sdk-request' }, data: { error: 'forbidden' } } },
  });
  assert.equal(sdkScopeError.code, 'COMPOSIO_CREDENTIALS_OR_SCOPE');
  assert.equal(sdkScopeError.providerRequestId, 'sdk-request');
  const localMutationAbort = classifyComposioFailure({
    error: { name: 'ComposioRequestCancelledError', message: 'request cancelled' }, mutation: true,
  });
  assert.equal(localMutationAbort.code, 'COMPOSIO_OUTCOME_UNKNOWN');
  assert.equal(localMutationAbort.retryable, false);
  const badVersion = classifyComposioFailure({ payload: { error: 'Tool schema did not include a concrete version.', code: 'COMPOSIO_BAD_RESPONSE', retryable: false } });
  assert.equal(badVersion.code, 'COMPOSIO_BAD_RESPONSE');
  assert.equal(badVersion.retryable, false);

  const [gateway, managedClient, mobile, tools, auth, registry, session, client] = await Promise.all([
    readFile('app/lib/composio/composio-gateway.ts', 'utf8'),
    readFile('app/lib/composio/managed-composio-client.ts', 'utf8'),
    readFile('app/lib/mobile/composio.ts', 'utf8'),
    readFile('app/lib/composio/composio-tools.ts', 'utf8'),
    readFile('app/lib/composio/composio-auth.ts', 'utf8'),
    readFile('app/lib/composio/composio-toolkit-registry.ts', 'utf8'),
    readFile('app/lib/composio/composio-session.ts', 'utf8'),
    readFile('app/lib/composio/composio-client.ts', 'utf8'),
  ]);
  assert.match(managedClient, /15_000/u);
  assert.match(managedClient, /30_000/u);
  assert.match(managedClient, /120_000/u);
  assert.match(managedClient, /operation === 'read' \? 2 : 1/u);
  assert.match(managedClient, /setTimeout\(resolve, error\.retryAfterMs\)/u);
  assert.match(managedClient, /COMPOSIO_BAD_RESPONSE/u);
  assert.match(gateway, /TOOL_VERSION_CACHE_TTL_MS = 30 \* 60 \* 1000/u);
  assert.match(gateway, /version && version !== 'latest'/u);
  assert.match(gateway, /code: 'COMPOSIO_BAD_RESPONSE'/u);
  assert.doesNotMatch(gateway, /dangerouslySkipVersionCheck/u);
  assert.match(gateway, /getRawComposioTools\(queryParams, undefined, \{ signal \}\)/u);
  assert.match(gateway, /getRawComposioToolBySlug\(action, undefined, \{ signal \}\)/u);
  assert.match(gateway, /tools\.execute\(action, \{/u);
  assert.match(gateway, /\}, \{ signal \}\), true\)/u);
  assert.match(gateway, /redirect_url: connected\.redirectUrl/u);
  assert.match(gateway, /triggers\.create\(composioUserId, input\.triggerSlug, \{/u);
  assert.match(gateway, /listTypes\([\s\S]*\}, \{ signal \}\)/u);
  assert.match(gateway, /listActive\([\s\S]*\}, \{ signal \}\)/u);
  assert.match(auth, /connectedAccounts\.list\(params[\s\S]*\{ signal \}\)/u);
  assert.match(auth, /authConfigs\.list\(\{\}, \{ signal \}\)/u);
  assert.match(auth, /session\.authorize\(toolkit, \{ callbackUrl: flow\.callbackUrl \}, \{ signal \}\)/u);
  assert.match(auth, /session\.toolkits\(\{\}, \{ signal \}\)/u);
  assert.match(registry, /toolkits\.get\(\{\}, \{ signal: controller\.signal \}\)/u);
  assert.match(registry, /getRawComposioTools\([\s\S]*undefined, \{ signal: controller\.signal \}\)/u);
  assert.match(session, /composio\.create\(context\.composioUserId, undefined, \{ signal: controller\.signal \}\)/u);
  assert.match(client, /connectedAccounts\.list\(\{ userIds: \[context\.composioUserId\], limit: 1 \}, \{ signal: controller\.signal \}\)/u);
  assert.match(mobile, /providerHealthy: status\.providerHealthy/u);
  assert.match(tools, /outcome_unknown/u);
  console.log('composio-reliability-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
