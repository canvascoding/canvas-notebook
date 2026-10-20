import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureMigrationDir, getMigrationDataRoot } from './paths';

export async function migrationTargetFingerprint(): Promise<string> {
  if (!process.env.DATABASE_URL) throw new Error('PostgreSQL migration requires DATABASE_URL.');
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid PostgreSQL migration target.');
  const root = path.resolve(getMigrationDataRoot());
  const instance = process.env.CANVAS_INSTANCE_ID || await fs.readFile(path.join(root, 'instance-id'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''; throw error;
  });
  const overrides = ['CANVAS_SECRETS_ENV_PATH', 'OAUTH_STORAGE_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH']
    .map(name => process.env[name] ? path.resolve(process.env[name]!) : null);
  return createHash('sha256').update(JSON.stringify([url.hostname, url.port || '5432', url.pathname, url.username, root, instance.trim(), overrides])).digest('hex');
}

export async function writeMigrationJson(filename: string, value: unknown): Promise<void> {
  await ensureMigrationDir(path.dirname(filename));
  const temporary = filename + '.' + randomUUID() + '.tmp';
  const file = await fs.open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  try {
    await fs.rename(temporary, filename);
    const directory = await fs.open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function readMigrationJson<T>(filename: string): Promise<T | null> {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 ** 2) throw new Error('Invalid migration state file.');
    return JSON.parse(await fs.readFile(filename, 'utf8')) as T;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
