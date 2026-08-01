import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const projectRoot = process.cwd();
  const panel = await readFile(
    path.join(projectRoot, 'app/components/license/CommunityTeamConnectionPanel.tsx'),
    'utf8',
  );
  const licensePanel = await readFile(
    path.join(projectRoot, 'app/components/license/LicenseActivationPanel.tsx'),
    'utf8',
  );
  const preflightRoute = await readFile(
    path.join(projectRoot, 'app/api/license/team/preflight/route.ts'),
    'utf8',
  );

  for (const endpoint of [
    '/api/license/claim/status',
    '/api/license/claim/start',
    '/api/license/claim/poll',
    '/api/license/claim/cancel',
    '/api/license/team/preflight',
  ]) {
    assert.match(panel, new RegExp(endpoint.replaceAll('/', '\\/'), 'u'));
  }
  assert.match(panel, /Account erstellen oder anmelden/u);
  assert.match(panel, /Create account or sign in/u);
  assert.match(panel, /Das Hosting, deine Daten und die Administration bleiben auf deinem eigenen Server/u);
  assert.match(panel, /Hosting, data and administration remain on your own server/u);
  assert.match(panel, /runPreflight/u);
  assert.match(panel, /target="_blank" rel="noopener noreferrer"/u);
  assert.match(panel, /preflight\.ready && preflight\.managementUrl/u);
  assert.match(licensePanel, /<CommunityTeamConnectionPanel/u);

  assert.doesNotMatch(panel, /instanceToken/u);
  assert.doesNotMatch(panel, /stripeCheckoutSessionId/u);
  assert.doesNotMatch(preflightRoute, /instanceToken/u);
  assert.doesNotMatch(preflightRoute, /stripeCheckoutSessionId/u);
  assert.match(preflightRoute, /requireInstanceAdmin\(request\)/u);
  assert.match(preflightRoute, /Cache-Control': 'no-store'/u);
  assert.match(preflightRoute, /managementUrl: ready \? getCommunityTeamManagementUrl\(\) : null/u);
}

main().then(() => console.log('community-license-connection-ui-test: ok'));
