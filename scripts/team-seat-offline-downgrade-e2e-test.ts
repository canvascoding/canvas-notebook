import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const scenarios = [
  {
    name: 'offline-refresh-grace-expiry-and-token-revocation',
    script: 'scripts/community-license-refresh-test.ts',
  },
  {
    name: 'connection-recovery-after-token-revocation',
    script: 'scripts/community-license-connection-recovery-test.ts',
  },
  {
    name: 'snapshot-retry-and-stale-reporting',
    script: 'scripts/team-membership-sync-test.ts',
  },
  {
    name: 'drift-nonpayment-and-cancellation-reconciliation',
    script: 'scripts/team-seat-reconciliation-test.ts',
  },
  {
    name: 'deterministic-solo-fallback-and-team-reactivation',
    script: 'scripts/team-license-lifecycle-test.ts',
  },
] as const;

const lifecycleSource = readFileSync(
  path.join(process.cwd(), 'app/lib/license/team-license-lifecycle.ts'),
  'utf8',
);
const refreshSource = readFileSync(
  path.join(process.cwd(), 'app/lib/license/refresh.ts'),
  'utf8',
);

assert.doesNotMatch(
  lifecycleSource,
  /DELETE\s+FROM\s+"?user"?/iu,
  'license downgrade must preserve every user identity',
);
assert.doesNotMatch(
  lifecycleSource,
  /DELETE\s+FROM\s+canvas_workspaces/iu,
  'license downgrade must preserve every workspace row',
);
assert.doesNotMatch(
  lifecycleSource,
  /rmSync|rm\(|unlink|rmdir/iu,
  'license downgrade must not delete persisted workspace data',
);
assert.match(lifecycleSource, /status = 'suspended'/u);
assert.match(lifecycleSource, /canvas_team_license_fallback/u);
assert.match(lifecycleSource, /status = 'active'/u);
assert.match(refreshSource, /graceExpiresAt/u);
assert.match(refreshSource, /reconnect_required/u);

const tsxBinary = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);
assert.equal(existsSync(tsxBinary), true, 'tsx must be installed before running offline E2E');

for (const scenario of scenarios) {
  assert.equal(
    existsSync(path.join(process.cwd(), scenario.script)),
    true,
    `${scenario.name} references missing test script ${scenario.script}`,
  );
  console.log(`\n[team-seat-offline-downgrade-e2e] ${scenario.name}`);
  const result = spawnSync(
    tsxBinary,
    ['--conditions=react-server', scenario.script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CANVAS_TEAM_SEAT_E2E_SCENARIO: scenario.name,
      },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${scenario.name} failed with exit status ${String(result.status)}`,
  );
}

console.log('\nteam-seat-offline-downgrade-e2e-test: ok');
