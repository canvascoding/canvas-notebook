import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const scenarios = [
  {
    name: 'direct-add-approval-payment-and-reactivation',
    script: 'scripts/membership-orchestrator-test.ts',
  },
  {
    name: 'invitation-preauthorization-and-activation',
    script: 'scripts/team-invitations-test.ts',
  },
  {
    name: 'suspend-and-remove',
    script: 'scripts/membership-suspension-test.ts',
  },
  {
    name: 'seat-limit-and-login-boundaries',
    script: 'scripts/seat-limit-guard-test.ts',
  },
] as const;

const userManagementSource = readFileSync(
  path.join(process.cwd(), 'app/components/settings/UserManagementPanel.tsx'),
  'utf8',
);
const invitationSource = readFileSync(
  path.join(process.cwd(), 'app/components/invitations/TeamInvitationAcceptancePanel.tsx'),
  'utf8',
);
const activationRouteSource = readFileSync(
  path.join(
    process.cwd(),
    'app/api/admin/organization/memberships/[membershipId]/activate/route.ts',
  ),
  'utf8',
);

for (const field of [
  'quantityBefore',
  'quantityAfter',
  'unitAmountCents',
  'recurringAmountCents',
  'immediateAmountCents',
  'nonBillable',
  'expiresAt',
]) {
  assert.match(
    userManagementSource,
    new RegExp(`membershipSeatQuote\\.quote\\.${field}`, 'u'),
    `the owner UI must render ${field} from the server-calculated Seat quote`,
  );
}
assert.match(userManagementSource, /membershipQuoteIsApproved/u);
assert.match(userManagementSource, /membershipExecutionIsPending/u);
assert.match(userManagementSource, /membershipSeatQuote\.approval\.url/u);
assert.match(userManagementSource, /target="_blank"/u);
assert.match(invitationSource, /quote\.quote\.unitAmountCents/u);
assert.match(invitationSource, /quote\.quote\.recurringAmountCents/u);
assert.match(invitationSource, /quote\.quote\.immediateAmountCents/u);
assert.match(
  invitationSource,
  /const approved = Boolean\([\s\S]*quote\.approval\.status/u,
);
assert.match(activationRouteSource, /status: result\.execution\.operation\.status/u);
assert.match(activationRouteSource, /paymentStatus: result\.execution\.operation\.paymentStatus/u);
assert.match(
  activationRouteSource,
  /status: result\.quote\.activation\.stage === 'active' \? 200 : 202/u,
  'only a fully active membership may return the completed activation status',
);

const tsxBinary = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);
assert.equal(existsSync(tsxBinary), true, 'tsx must be installed before running paid activation E2E');

for (const scenario of scenarios) {
  assert.equal(
    existsSync(path.join(process.cwd(), scenario.script)),
    true,
    `${scenario.name} references missing test script ${scenario.script}`,
  );
  console.log(`\n[team-seat-paid-activation-e2e] ${scenario.name}`);
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

console.log('\nteam-seat-paid-activation-e2e-test: ok');
