import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const scenarios = [
  {
    name: 'community-claim-and-cancel',
    script: 'scripts/community-license-claim-client-test.ts',
  },
  {
    name: 'team-upgrade-preflight-and-checkout-handoff',
    script: 'scripts/community-team-upgrade-preflight-test.ts',
  },
  {
    name: 'claim-and-upgrade-settings-contract',
    script: 'scripts/community-license-connection-ui-test.ts',
  },
  {
    name: 'same-instance-certificate-and-retry-contract',
    script: 'scripts/team-control-plane-mock-integration-test.ts',
  },
  {
    name: 'community-solo-remains-usable',
    script: 'scripts/auth-seat-limit-test.ts',
  },
] as const;

const tsxBinary = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);
assert.equal(existsSync(tsxBinary), true, 'tsx must be installed before running the upgrade E2E suite');

const panelSource = readFileSync(
  path.join(process.cwd(), 'app/components/license/CommunityTeamConnectionPanel.tsx'),
  'utf8',
);
const preflightRouteSource = readFileSync(
  path.join(process.cwd(), 'app/api/license/team/preflight/route.ts'),
  'utf8',
);
const controlPlaneClientSource = readFileSync(
  path.join(process.cwd(), 'app/lib/license/control-plane.ts'),
  'utf8',
);

assert.match(panelSource, /\/api\/license\/claim\/start/u);
assert.match(panelSource, /\/api\/license\/claim\/cancel/u);
assert.match(panelSource, /\/api\/license\/team\/preflight/u);
assert.match(panelSource, /preflight\.ready && preflight\.managementUrl/u);
assert.match(
  panelSource,
  /href=\{preflight\.managementUrl\} target="_blank" rel="noopener noreferrer"/u,
  'checkout must remain an explicit external Control Plane handoff',
);
assert.match(preflightRouteSource, /managementUrl: ready \? getCommunityTeamManagementUrl\(\) : null/u);
assert.doesNotMatch(
  `${panelSource}\n${preflightRouteSource}`,
  /\/api\/migration\/|database-migration|prepare-postgres|migration\/restore/u,
  'claim, preflight, and checkout handoff must not start a VM or database migration',
);
assert.doesNotMatch(
  controlPlaneClientSource,
  /migration\/restore|prepare-postgres|database-migration/u,
  'the Notebook Control Plane license client must not own VM migration commands',
);
assert.match(
  controlPlaneClientSource,
  /preflight\.license\.instanceId !== instanceId/u,
  'preflight must reject a Control Plane response for another Notebook instance',
);
assert.match(
  controlPlaneClientSource,
  /refreshed\.details\.instanceId !== instanceId/u,
  'the Team certificate refresh must stay bound to the claimed Notebook instance',
);

for (const scenario of scenarios) {
  assert.equal(
    existsSync(path.join(process.cwd(), scenario.script)),
    true,
    `${scenario.name} references missing test script ${scenario.script}`,
  );
  console.log(`\n[team-seat-community-upgrade-e2e] ${scenario.name}`);
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

console.log('\nteam-seat-community-upgrade-e2e-test: ok');
