import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const scenarios = [
  {
    name: 'separate-test-signature-and-production-rejection',
    script: 'scripts/license-environment-isolation-test.ts',
  },
  {
    name: 'claim-refresh-quote-and-retry-contract',
    script: 'scripts/team-control-plane-mock-integration-test.ts',
  },
  {
    name: 'non-billable-test-provider-contract',
    script: 'scripts/team-seat-contract-test.ts',
  },
  {
    name: 'signed-seat-activation-failures-expiry-and-revocation',
    script: 'scripts/team-seat-test-license-activation-test.ts',
  },
  {
    name: 'non-billable-owner-health-ui',
    script: 'scripts/team-seat-health-test.ts',
  },
] as const;

const root = process.cwd();
const tsxBinary = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);
assert.equal(existsSync(tsxBinary), true, 'tsx must be installed before no-Stripe E2E');

const activationSource = readFileSync(
  path.join(root, 'scripts/team-seat-test-license-activation-test.ts'),
  'utf8',
);
const healthPanelSource = readFileSync(
  path.join(root, 'app/components/license/TeamSeatHealthPanel.tsx'),
  'utf8',
);
const userPanelSource = readFileSync(
  path.join(root, 'app/components/settings/UserManagementPanel.tsx'),
  'utf8',
);
const invitationSource = readFileSync(
  path.join(root, 'app/components/invitations/TeamInvitationAcceptancePanel.tsx'),
  'utf8',
);

assert.match(activationSource, /provider:\s*'test'/u);
assert.match(activationSource, /nonBillable:\s*true/u);
assert.match(activationSource, /recurringAmountCents:\s*0/u);
assert.match(activationSource, /delete process\.env\.STRIPE_SECRET_KEY/u);
assert.match(activationSource, /delete process\.env\.STRIPE_WEBHOOK_SECRET/u);
assert.doesNotMatch(activationSource, /stripe\.com|new Stripe|checkout\.sessions/u);
assert.match(healthPanelSource, /TEST LICENSE/u);
assert.match(healthPanelSource, /NON-BILLABLE/u);
assert.match(userPanelSource, /nonBillable/u);
assert.match(invitationSource, /nonBillable/u);

const childEnvironment = { ...process.env };
delete childEnvironment.STRIPE_SECRET_KEY;
delete childEnvironment.STRIPE_WEBHOOK_SECRET;
delete childEnvironment.STRIPE_PRICE_ID;
delete childEnvironment.STRIPE_TEAM_SEAT_PRICE_ID;

for (const scenario of scenarios) {
  const absoluteScript = path.join(root, scenario.script);
  assert.equal(
    existsSync(absoluteScript),
    true,
    `${scenario.name} references missing test script ${scenario.script}`,
  );
  console.log(`\n[team-seat-no-stripe-test-license-e2e] ${scenario.name}`);
  const result = spawnSync(
    tsxBinary,
    ['--conditions=react-server', scenario.script],
    {
      cwd: root,
      env: {
        ...childEnvironment,
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

assert.equal(process.env.STRIPE_SECRET_KEY, undefined);
assert.equal(process.env.STRIPE_WEBHOOK_SECRET, undefined);

console.log('\nteam-seat-no-stripe-test-license-e2e-test: ok');
