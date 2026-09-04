import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { composeEnvText, createDefaultConfig } from '../cli/src/core/config';
import { renderComposeFile } from '../cli/src/core/compose';
import { resolveDefaultPaths } from '../cli/src/core/platform';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  const paths = resolveDefaultPaths('linux', {
    HOME: '/tmp/canvas-updater-installer-test',
    CANVAS_INSTALL_DIR: '/opt/canvas-notebook',
    CANVAS_DATA_DIR: '/srv/canvas-data',
  });
  const config = createDefaultConfig(paths, 'linux');
  const manualCompose = renderComposeFile(config, 'linux');
  assert.equal(manualCompose.includes('canvas-notebook-updater.sock'), false);
  assert.equal(manualCompose.includes('group_add:'), false);

  config.env.CANVAS_STANDALONE_UPDATER_ENABLED = true;
  config.env.CANVAS_UPDATER_GID = '987';
  const standaloneCompose = renderComposeFile(config, 'linux');
  assert.match(standaloneCompose, /group_add:\n\s+- "\$\{CANVAS_UPDATER_GID:\?/u);
  assert.match(standaloneCompose, /\/run\/canvas-notebook-updater\.sock:\/run\/canvas-notebook-updater\.sock/u);
  assert.match(composeEnvText(config, '/srv/canvas-data'), /^CANVAS_STANDALONE_UPDATER_ENABLED=true$/mu);
  assert.match(composeEnvText(config, '/srv/canvas-data'), /^CANVAS_UPDATER_GID=987$/mu);

  const socketUnit = await fs.readFile(path.join(root, 'install/templates/canvas-notebook-updater.socket'), 'utf8');
  const serviceUnit = await fs.readFile(path.join(root, 'install/templates/canvas-notebook-updater.service'), 'utf8');
  const timerServiceUnit = await fs.readFile(path.join(root, 'install/templates/canvas-notebook-update.service'), 'utf8');
  assert.match(socketUnit, /^ListenStream=\/run\/canvas-notebook-updater\.sock$/mu);
  assert.match(socketUnit, /^SocketGroup=canvas-notebook-updater$/mu);
  assert.match(socketUnit, /^SocketMode=0660$/mu);
  assert.match(socketUnit, /^WantedBy=sockets\.target$/mu);
  assert.match(serviceUnit, /^ExecStart=.* updater-service --no-banner$/mu);
  assert.match(serviceUnit, /^MemoryHigh=75M$/mu);
  assert.match(serviceUnit, /^MemoryMax=128M$/mu);
  assert.match(serviceUnit, /^NoNewPrivileges=true$/mu);
  assert.match(serviceUnit, /^Restart=no$/mu);
  assert.equal(serviceUnit.includes('CANVAS_CONTROL_PLANE_URL'), false);
  assert.equal(serviceUnit.includes('docker.sock'), false);
  assert.match(timerServiceUnit, /^ExecStart=.* updater-trigger --channel stable --no-banner$/mu);
  assert.equal(timerServiceUnit.includes(' update --require-pinned'), false);

  const installer = await fs.readFile(path.join(root, 'install.sh'), 'utf8');
  const systemd = await fs.readFile(path.join(root, 'install/lib/systemd.sh'), 'utf8');
  const appServiceUnit = await fs.readFile(path.join(root, 'install/templates/canvas-notebook.service'), 'utf8');
  assert.match(installer, /prepare_standalone_updater_config[\s\S]+install_management_cli[\s\S]+install_standalone_updater[\s\S]+install_systemd_service/u);
  assert.match(systemd, /config_json_managed_by_control_plane[\s\S]+remove_standalone_updater_units/u);
  assert.match(systemd, /No update trust store was installed; in-app updates remain fail-closed/u);
  assert.match(systemd, /systemctl enable "\$socket_unit"/u);
  assert.doesNotMatch(systemd, /systemctl enable "\$service_unit"/u);
  assert.match(appServiceUnit, /^Requires=docker\.service __UPDATER_REQUIRES__$/mu);
  assert.match(systemd, /__UPDATER_REQUIRES__[\s\S]+updater_dependency/u);

  console.log('standalone-updater-installer-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
