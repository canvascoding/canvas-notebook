import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  const [panel, settings, navigation, route, compose] = await Promise.all([
    fs.readFile(path.join(root, 'app/components/settings/UpdateCenterPanel.tsx'), 'utf8'),
    fs.readFile(path.join(root, 'app/components/settings/IntegrationsSettingsClient.tsx'), 'utf8'),
    fs.readFile(path.join(root, 'app/components/settings/SettingsNavigation.tsx'), 'utf8'),
    fs.readFile(path.join(root, 'app/api/admin/system-updates/route.ts'), 'utf8'),
    fs.readFile(path.join(root, 'install/lib/shared/compose.sh'), 'utf8'),
  ]);

  assert.match(navigation, /value: 'system-updates'/u);
  assert.match(settings, /tab\.value === 'system-updates'\) return isAdmin/u);
  assert.match(settings, /renderLazyTabContent\('system-updates', <UpdateCenterPanel/u);
  assert.match(route, /requireInstanceAdmin\(request\)/u);
  assert.match(route, /recordAuditEvent/u);
  assert.match(panel, /canvas\.system-update\.operation-id/u);
  assert.match(panel, /setConnectionInterrupted\(true\)/u);
  assert.match(panel, /text\/event-stream/u);
  assert.match(panel, /Authorization: `Bearer \$\{statusAccess\.ticket\}`/u);
  assert.match(panel, /fetch\('\/api\/health'/u);
  assert.match(panel, /availability && availability\.mode !== 'manual'/u);
  assert.doesNotMatch(panel, /targetImageRef/u, 'the update UI must not accept or display arbitrary image references');
  assert.match(compose, /canvas-notebook-updater\.sock:\/run\/canvas-notebook-updater\.sock/u);
  assert.doesNotMatch(compose, /docker\.sock/u, 'the application container must not receive the Docker socket');

  console.log('system update UI contract test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
