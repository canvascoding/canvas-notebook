import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

type ReleaseScenario = {
  name: string;
  script: string;
};

const releaseScenarios: ReleaseScenario[] = [
  {
    name: 'shared-protocol-contract',
    script: 'scripts/team-seat-contract-test.ts',
  },
  {
    name: 'legacy-installation-migration',
    script: 'scripts/team-seat-legacy-migration-test.ts',
  },
  {
    name: 'membership-state-and-seat-limit-matrix',
    script: 'scripts/team-seat-membership-state-matrix-test.ts',
  },
  {
    name: 'control-plane-client-integration',
    script: 'scripts/team-control-plane-mock-integration-test.ts',
  },
  {
    name: 'community-to-team-upgrade',
    script: 'scripts/team-seat-community-upgrade-e2e-test.ts',
  },
  {
    name: 'paid-seat-activation',
    script: 'scripts/team-seat-paid-activation-e2e-test.ts',
  },
  {
    name: 'offline-grace-and-downgrade',
    script: 'scripts/team-seat-offline-downgrade-e2e-test.ts',
  },
  {
    name: 'no-stripe-test-license',
    script: 'scripts/team-seat-no-stripe-test-license-e2e-test.ts',
  },
];

const root = process.cwd();
const tsxBinary = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);
assert.equal(existsSync(tsxBinary), true, 'tsx must be installed before release verification');

const packageJson = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8'),
) as { version?: unknown };
assert.equal(typeof packageJson.version, 'string');
const notebookVersion = packageJson.version as string;
const protocolVersion = 'canvas-team-seat-protocol-v1';

const ownerGuide = readFileSync(
  path.join(root, 'docs/team-seat-licensing-owner-guide.md'),
  'utf8',
);
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

assert.match(ownerGuide, new RegExp(`Canvas Notebook \\| \`${notebookVersion.replaceAll('.', '\\.')}\``));
assert.match(ownerGuide, new RegExp(protocolVersion, 'u'));
assert.match(ownerGuide, /Canvas Control Plane API \| `1\.0\.53`/u);
assert.match(ownerGuide, /without internet access/iu);
assert.match(ownerGuide, /explicitly approve/iu);
assert.match(ownerGuide, /grace window/iu);
assert.match(ownerGuide, /does not delete user identities/iu);
assert.match(ownerGuide, /reuses the existing instance/iu);
assert.match(readme, /skip activation and continue in local Solo mode/iu);
assert.match(readme, /docs\/team-seat-licensing-owner-guide\.md/u);
assert.match(changelog, /tsx scripts\/team-seat-release-verification-test\.ts/u);

for (const scenario of releaseScenarios) {
  const absoluteScript = path.join(root, scenario.script);
  assert.equal(
    existsSync(absoluteScript),
    true,
    `${scenario.name} references missing test script ${scenario.script}`,
  );
  console.log(`\n[team-seat-release-verification] ${scenario.name}`);
  const result = spawnSync(
    tsxBinary,
    ['--conditions=react-server', scenario.script],
    {
      cwd: root,
      env: {
        ...process.env,
        CANVAS_TEAM_SEAT_RELEASE_SCENARIO: scenario.name,
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

console.log('\nteam-seat-release-verification-test: ok');
