import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  configureRuntimeAndDatabase,
  createDefaultConfig,
  materializeConfig,
  writeConfig,
  writeEnvFiles,
  writeSecureFile,
} from '../cli/src/core/config';
import { composePath, resolveDefaultPaths } from '../cli/src/core/platform';
import {
  assertPostgresRecoveryCompatible,
  clearPostgresRecoveryJournal,
  createPostgresRecoverySnapshot,
  readPostgresRecoveryJournal,
  readPostgresRecoverySnapshot,
  restorePostgresRecoverySnapshot,
  writePostgresRecoveryJournal,
} from '../cli/src/core/postgresRecovery';

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-postgres-recovery-'));
  try {
    const paths = resolveDefaultPaths('linux', {
      ...process.env,
      HOME: path.join(root, 'home'),
      CANVAS_INSTALL_DIR: path.join(root, 'install'),
      CANVAS_DATA_DIR: path.join(root, 'data'),
      CANVAS_MANAGER_LOG_FILE: path.join(root, 'manager.log'),
    });
    const rollbackConfig = materializeConfig(configureRuntimeAndDatabase(createDefaultConfig(paths, 'linux'), { database: 'postgres' }));
    rollbackConfig.env.CANVAS_POSTGRES_PASSWORD = 'recovery-old-password-123';
    rollbackConfig.env.DATABASE_URL = 'postgresql://canvas:recovery-old-password-123@postgres:5432/canvas_notebook';
    await writeConfig(rollbackConfig);
    await writeEnvFiles(rollbackConfig, composePath(rollbackConfig.dataDir, 'linux'));
    const oldContainerEnv = await fs.readFile(paths.containerEnvFile, 'utf8');
    const oldComposeEnv = await fs.readFile(paths.composeEnvFile, 'utf8');

    const targetConfig = structuredClone(rollbackConfig);
    targetConfig.env.CANVAS_POSTGRES_PASSWORD = 'recovery-new-password-456';
    targetConfig.env.DATABASE_URL = 'postgresql://canvas:recovery-new-password-456@postgres:5432/canvas_notebook';
    await writeConfig(targetConfig);
    await createPostgresRecoverySnapshot(targetConfig, {
      rollbackConfig,
      containerEnv: oldContainerEnv,
      composeEnv: oldComposeEnv,
    });
    let journal = await writePostgresRecoveryJournal(targetConfig, rollbackConfig, 'forward', null);
    const journalPath = path.join(paths.installDir, '.postgres-auth-reconcile.json');
    const statePath = path.join(paths.installDir, '.postgres-auth-reconcile-state');
    const journalText = await fs.readFile(journalPath, 'utf8');
    assert.equal(journalText.includes('recovery-old-password-123'), false);
    assert.equal(journalText.includes('recovery-new-password-456'), false);
    assert.equal((await fs.stat(journalPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(statePath)).mode & 0o777, 0o700);
    for (const file of ['rollback-config.json', 'container.env', 'compose.env']) {
      assert.equal((await fs.stat(path.join(statePath, file))).mode & 0o777, 0o600);
    }
    await assertPostgresRecoveryCompatible(targetConfig, journal);

    const unrelatedConfig = structuredClone(targetConfig);
    unrelatedConfig.env.CANVAS_POSTGRES_PASSWORD = 'unrelated-password-789';
    unrelatedConfig.env.DATABASE_URL = 'postgresql://canvas:unrelated-password-789@postgres:5432/canvas_notebook';
    await assert.rejects(assertPostgresRecoveryCompatible(unrelatedConfig, journal), /credentials changed/u);

    await writeEnvFiles(targetConfig, composePath(targetConfig.dataDir, 'linux'));
    const targetContainerEnv = await fs.readFile(paths.containerEnvFile, 'utf8');
    await writeSecureFile(paths.containerEnvFile, targetContainerEnv);
    await writeSecureFile(paths.composeEnvFile, oldComposeEnv);
    const preservedSnapshot = await readPostgresRecoverySnapshot(targetConfig, journal);
    assert.equal(preservedSnapshot.containerEnv, oldContainerEnv);
    assert.equal(preservedSnapshot.composeEnv, oldComposeEnv);

    journal = await writePostgresRecoveryJournal(targetConfig, rollbackConfig, 'rollback', journal);
    assert.equal((await readPostgresRecoveryJournal(targetConfig))?.state, 'rollback');
    await restorePostgresRecoverySnapshot(preservedSnapshot);
    const restoredConfig = JSON.parse(await fs.readFile(paths.configFile, 'utf8')) as { env: Record<string, string> };
    assert.equal(restoredConfig.env.CANVAS_POSTGRES_PASSWORD, 'recovery-old-password-123');
    assert.equal(await fs.readFile(paths.containerEnvFile, 'utf8'), oldContainerEnv);
    assert.equal(await fs.readFile(paths.composeEnvFile, 'utf8'), oldComposeEnv);

    await clearPostgresRecoveryJournal(targetConfig);
    assert.equal(await fs.access(journalPath).then(() => true, () => false), false);
    assert.equal(await fs.access(statePath).then(() => true, () => false), false);
    console.log('cli postgres recovery state tests passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
