import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  assertProductionAuthSecret,
  LOCAL_DEVELOPMENT_AUTH_SECRET,
  resolveAuthSecret,
} from '../app/lib/security/auth-secret';

const strongSecret = 'a-secure-production-auth-secret-1234567890';

assert.equal(
  resolveAuthSecret({ NODE_ENV: 'development' }),
  LOCAL_DEVELOPMENT_AUTH_SECRET,
  'Local development should remain usable without secret setup.'
);
assert.equal(
  resolveAuthSecret({ NODE_ENV: 'test', AUTH_SECRET: strongSecret }),
  strongSecret
);

for (const environment of [
  { NODE_ENV: 'production' },
  { NODE_ENV: 'production', BETTER_AUTH_SECRET: 'too-short' },
  { NODE_ENV: 'production', BETTER_AUTH_SECRET: LOCAL_DEVELOPMENT_AUTH_SECRET },
]) {
  assert.throws(
    () => assertProductionAuthSecret(environment),
    /Production requires BETTER_AUTH_SECRET or AUTH_SECRET/u
  );
  assert.throws(
    () => resolveAuthSecret(environment),
    /Production requires BETTER_AUTH_SECRET or AUTH_SECRET/u
  );
}

assert.doesNotThrow(() => assertProductionAuthSecret({
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: strongSecret,
}));
assert.equal(
  resolveAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: strongSecret }),
  strongSecret
);
assert.equal(
  resolveAuthSecret({ NODE_ENV: 'production', AUTH_SECRET: strongSecret }),
  strongSecret,
  'The supported legacy AUTH_SECRET name should keep working.'
);
assert.equal(
  resolveAuthSecret(
    { NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' },
    { allowProductionBuildFallback: true }
  ),
  LOCAL_DEVELOPMENT_AUTH_SECRET,
  'A secretless image build must remain possible because runtime validation runs at startup.'
);
assert.throws(
  () => assertProductionAuthSecret({
    NODE_ENV: 'production',
    NEXT_PHASE: 'phase-production-build',
  }),
  /Production requires BETTER_AUTH_SECRET or AUTH_SECRET/u,
  'The startup assertion must never honor the build-only exception.'
);

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const instrumentationSource = readFileSync(new URL('../instrumentation.ts', import.meta.url), 'utf8');
assert.match(serverSource, /assertProductionAuthSecret\(\)/u);
assert.match(instrumentationSource, /assertProductionAuthSecret\(\)/u);

console.log('auth-secret-security-test: ok');
