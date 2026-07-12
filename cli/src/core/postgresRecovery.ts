import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { writeConfig, writeSecureFile } from './config';
import type { CanvasCliConfig } from './types';

export type PostgresRecoveryState = 'forward' | 'rollback';

export interface PostgresRecoveryJournal {
  version: 1;
  operation: 'postgres_auth_reconcile';
  state: PostgresRecoveryState;
  targetFingerprint: string;
  rollbackFingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface PostgresRecoverySnapshot {
  rollbackConfig: CanvasCliConfig;
  containerEnv: string;
  composeEnv: string;
}

function recoveryJournalPath(config: CanvasCliConfig, env: NodeJS.ProcessEnv): string {
  return path.resolve(env.CANVAS_POSTGRES_RECONCILE_JOURNAL || path.join(config.paths.installDir, '.postgres-auth-reconcile.json'));
}

function recoveryStatePath(config: CanvasCliConfig, env: NodeJS.ProcessEnv): string {
  return path.resolve(env.CANVAS_POSTGRES_RECONCILE_STATE_DIR || path.join(config.paths.installDir, '.postgres-auth-reconcile-state'));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r').catch(() => null);
  if (!handle) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableSecureFile(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  const handle = await fs.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJournalFile(filePath: string, journal: PostgresRecoveryJournal): Promise<void> {
  await writeDurableSecureFile(filePath, `${JSON.stringify(journal)}\n`);
}

export function postgresCredentialFingerprint(config: CanvasCliConfig): string {
  const values = [
    String(config.env.CANVAS_POSTGRES_USER || 'canvas'),
    String(config.env.CANVAS_POSTGRES_DB || 'canvas_notebook'),
    String(config.env.CANVAS_POSTGRES_PASSWORD || ''),
    String(config.env.DATABASE_URL || ''),
  ];
  const hash = crypto.createHash('sha256');
  for (const value of values) {
    hash.update(value, 'utf8');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function parseJournal(raw: string): PostgresRecoveryJournal {
  const value = JSON.parse(raw) as Partial<PostgresRecoveryJournal>;
  const fingerprint = /^[a-f0-9]{64}$/u;
  if (value.version !== 1 || value.operation !== 'postgres_auth_reconcile' ||
    (value.state !== 'forward' && value.state !== 'rollback') ||
    typeof value.targetFingerprint !== 'string' || !fingerprint.test(value.targetFingerprint) ||
    typeof value.rollbackFingerprint !== 'string' || !fingerprint.test(value.rollbackFingerprint) ||
    typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new Error('Postgres auth recovery journal is malformed; refusing to mutate the database.');
  }
  return value as PostgresRecoveryJournal;
}

export async function readPostgresRecoveryJournal(
  config: CanvasCliConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PostgresRecoveryJournal | null> {
  const filePath = recoveryJournalPath(config, env);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  await fs.chmod(filePath, 0o600);
  return parseJournal(raw);
}

export async function assertPostgresRecoveryCompatible(
  config: CanvasCliConfig,
  journal: PostgresRecoveryJournal,
): Promise<void> {
  const currentFingerprint = postgresCredentialFingerprint(config);
  if (currentFingerprint !== journal.targetFingerprint && currentFingerprint !== journal.rollbackFingerprint) {
    throw new Error('Postgres credentials changed while an interrupted reconciliation is pending; refusing automatic recovery.');
  }
}

export async function createPostgresRecoverySnapshot(
  config: CanvasCliConfig,
  snapshot: PostgresRecoverySnapshot,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const statePath = recoveryStatePath(config, env);
  const tempPath = `${statePath}.next-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  await fs.rm(tempPath, { recursive: true, force: true });
  await fs.mkdir(tempPath, { recursive: true, mode: 0o700 });
  await fs.chmod(tempPath, 0o700);
  await Promise.all([
    writeDurableSecureFile(path.join(tempPath, 'rollback-config.json'), `${JSON.stringify(snapshot.rollbackConfig, null, 2)}\n`),
    writeDurableSecureFile(path.join(tempPath, 'container.env'), snapshot.containerEnv),
    writeDurableSecureFile(path.join(tempPath, 'compose.env'), snapshot.composeEnv),
  ]);
  await syncDirectory(tempPath);
  await fs.rm(statePath, { recursive: true, force: true });
  await fs.rename(tempPath, statePath);
  await fs.chmod(statePath, 0o700);
  await syncDirectory(path.dirname(statePath));
}

export async function readPostgresRecoverySnapshot(
  config: CanvasCliConfig,
  journal: PostgresRecoveryJournal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PostgresRecoverySnapshot> {
  const statePath = recoveryStatePath(config, env);
  let rollbackConfig: CanvasCliConfig;
  let containerEnv: string;
  let composeEnv: string;
  try {
    [rollbackConfig, containerEnv, composeEnv] = await Promise.all([
      fs.readFile(path.join(statePath, 'rollback-config.json'), 'utf8').then((raw) => JSON.parse(raw) as CanvasCliConfig),
      fs.readFile(path.join(statePath, 'container.env'), 'utf8'),
      fs.readFile(path.join(statePath, 'compose.env'), 'utf8'),
    ]);
  } catch {
    throw new Error('Postgres auth recovery state is incomplete; refusing to mutate the database.');
  }
  if (postgresCredentialFingerprint(rollbackConfig) !== journal.rollbackFingerprint) {
    throw new Error('Postgres auth recovery state does not match its journal; refusing to mutate the database.');
  }
  if (rollbackConfig.paths.installDir !== config.paths.installDir ||
    rollbackConfig.paths.configFile !== config.paths.configFile ||
    rollbackConfig.paths.containerEnvFile !== config.paths.containerEnvFile ||
    rollbackConfig.paths.composeEnvFile !== config.paths.composeEnvFile) {
    throw new Error('Postgres auth recovery state contains unexpected paths; refusing to mutate the database.');
  }
  await fs.chmod(statePath, 0o700);
  await Promise.all([
    fs.chmod(path.join(statePath, 'rollback-config.json'), 0o600),
    fs.chmod(path.join(statePath, 'container.env'), 0o600),
    fs.chmod(path.join(statePath, 'compose.env'), 0o600),
  ]);
  return { rollbackConfig, containerEnv, composeEnv };
}

export async function restorePostgresRecoverySnapshot(
  snapshot: PostgresRecoverySnapshot,
): Promise<void> {
  await writeConfig(snapshot.rollbackConfig);
  await Promise.all([
    writeSecureFile(snapshot.rollbackConfig.paths.containerEnvFile, snapshot.containerEnv),
    writeSecureFile(snapshot.rollbackConfig.paths.composeEnvFile, snapshot.composeEnv),
  ]);
}

export async function writePostgresRecoveryJournal(
  config: CanvasCliConfig,
  rollbackConfig: CanvasCliConfig,
  state: PostgresRecoveryState,
  existing: PostgresRecoveryJournal | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PostgresRecoveryJournal> {
  const now = new Date().toISOString();
  const journal: PostgresRecoveryJournal = {
    version: 1,
    operation: 'postgres_auth_reconcile',
    state,
    targetFingerprint: postgresCredentialFingerprint(config),
    rollbackFingerprint: postgresCredentialFingerprint(rollbackConfig),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await writeJournalFile(recoveryJournalPath(config, env), journal);
  return journal;
}

export async function clearPostgresRecoveryJournal(
  config: CanvasCliConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = recoveryJournalPath(config, env);
  await fs.rm(filePath, { force: true });
  await fs.rm(recoveryStatePath(config, env), { recursive: true, force: true });
  await syncDirectory(path.dirname(filePath));
}

export async function hasPostgresRecoveryJournal(
  config: CanvasCliConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return fs.access(recoveryJournalPath(config, env)).then(() => true, () => false);
}
