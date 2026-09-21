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

  const [gateway, managedClient, mobile, tools] = await Promise.all([
    readFile('app/lib/composio/composio-gateway.ts', 'utf8'),
    readFile('app/lib/composio/managed-composio-client.ts', 'utf8'),
    readFile('app/lib/mobile/composio.ts', 'utf8'),
    readFile('app/lib/composio/composio-tools.ts', 'utf8'),
  ]);
  assert.match(managedClient, /15_000/u);
  assert.match(managedClient, /30_000/u);
  assert.match(managedClient, /120_000/u);
  assert.match(managedClient, /operation === 'read' \? 2 : 1/u);
  assert.match(managedClient, /setTimeout\(resolve, error\.retryAfterMs\)/u);
  assert.match(managedClient, /COMPOSIO_BAD_RESPONSE/u);
  assert.match(gateway, /TOOL_VERSION_CACHE_TTL_MS = 30 \* 60 \* 1000/u);
  assert.doesNotMatch(gateway, /dangerouslySkipVersionCheck/u);
  assert.match(gateway, /result\.auth_required !== true/u);
  assert.match(mobile, /providerHealthy: status\.providerHealthy/u);
  assert.match(tools, /outcome_unknown/u);
  console.log('composio-reliability-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
