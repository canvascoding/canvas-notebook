import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

type MembershipFlow = {
  name: string;
  script: string;
  covers: readonly string[];
};

const flows: readonly MembershipFlow[] = [
  {
    name: 'seat-state-boundaries',
    script: 'scripts/seat-limit-guard-test.ts',
    covers: [
      'all pending membership states',
      'seatLimit enforcement',
      'Community Solo activation rejection',
      'mobile and workspace bootstrap guards',
    ],
  },
  {
    name: 'direct-add-and-reactivation',
    script: 'scripts/membership-orchestrator-test.ts',
    covers: [
      'direct add',
      'approval',
      'requires_action',
      'stale quote',
      'reactivation',
      'concurrent capacity',
    ],
  },
  {
    name: 'invite-and-accept',
    script: 'scripts/team-invitations-test.ts',
    covers: [
      'invite',
      'accept',
      'approval',
      'activation',
      'revoke',
      'expire',
    ],
  },
  {
    name: 'roles',
    script: 'scripts/organization-permission-guards-test.ts',
    covers: [
      'role changes',
      'stable Seat quantity',
      'idempotent role replay',
    ],
  },
  {
    name: 'suspend-and-remove',
    script: 'scripts/membership-suspension-test.ts',
    covers: [
      'suspend',
      'remove',
      'session revocation',
      'owner protection',
    ],
  },
  {
    name: 'membership-state-machine',
    script: 'scripts/team-membership-model-test.ts',
    covers: [
      'invited',
      'approval_required',
      'billing_pending',
      'active',
      'suspended',
      'removed',
    ],
  },
  {
    name: 'bootstrap',
    script: 'scripts/auth-setup-test.ts',
    covers: [
      'first owner bootstrap',
      'repeat bootstrap',
      'Community Solo bootstrap boundary',
    ],
  },
  {
    name: 'legacy-import',
    script: 'scripts/team-seat-legacy-migration-test.ts',
    covers: [
      'Community Solo import',
      'Managed Single import',
      'Managed Team import',
      'idempotent partial migration',
    ],
  },
  {
    name: 'login',
    script: 'scripts/auth-seat-limit-test.ts',
    covers: [
      'owner login',
      'second Solo user rejection',
      'session restore rejection',
    ],
  },
] as const;

const requiredFlowNames = new Set([
  'seat-state-boundaries',
  'direct-add-and-reactivation',
  'invite-and-accept',
  'roles',
  'suspend-and-remove',
  'membership-state-machine',
  'bootstrap',
  'legacy-import',
  'login',
]);

assert.deepEqual(
  new Set(flows.map((flow) => flow.name)),
  requiredFlowNames,
  'the Team Seat membership matrix must keep every activation and deactivation entry point covered',
);

for (const flow of flows) {
  const absoluteScript = path.join(process.cwd(), flow.script);
  assert.equal(
    existsSync(absoluteScript),
    true,
    `${flow.name} references missing test script ${flow.script}`,
  );
  assert.ok(flow.covers.length > 0, `${flow.name} must declare its contract coverage`);
}

const tsxBinary = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);
assert.equal(existsSync(tsxBinary), true, 'tsx must be installed before running the membership matrix');

for (const flow of flows) {
  console.log(`\n[team-seat-membership-matrix] ${flow.name}`);
  const result = spawnSync(
    tsxBinary,
    ['--conditions=react-server', flow.script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CANVAS_TEAM_SEAT_TEST_SCENARIO: flow.name,
      },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${flow.name} failed with exit status ${String(result.status)}`,
  );
}

console.log('\nteam-seat-membership-state-matrix-test: ok');
