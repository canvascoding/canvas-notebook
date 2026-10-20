/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runPendingMigrationBeforeBoot(appRoot, env = process.env) {
  const root = path.resolve(appRoot, env.DATA || env.CANVAS_DATA_ROOT || 'data');
  if (!['pending-restore.json', 'restore-in-progress.json'].some(name => fs.existsSync(path.join(root, '.migration', name)))) return;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--conditions', 'react-server',
    path.join(appRoot, 'scripts/apply-pending-migration.ts')], { cwd: appRoot, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Migration recovery must finish before the application can start.');
}

module.exports = { runPendingMigrationBeforeBoot };
