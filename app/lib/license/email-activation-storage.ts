import 'server-only';

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveSecretsDir } from '@/app/lib/runtime-data-paths';

const DIRECTORY_NAME = 'license-email-activation';
const FILE_NAME = 'pending.json';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POLL_TOKEN_PATTERN = /^lep_[0-9a-f]{64}$/u;

export type PendingLicenseEmailActivation = {
  schemaVersion: 1;
  activationId: string;
  instanceId: string;
  pollToken: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  createdAt: string;
  updatedAt: string;
};

export class LicenseEmailActivationStorageError extends Error {
  constructor(
    message: string,
    public readonly code = 'LICENSE_EMAIL_ACTIVATION_STORAGE_FAILED',
  ) {
    super(message);
    this.name = 'LicenseEmailActivationStorageError';
  }
}

function activationDirectory() {
  return path.join(resolveSecretsDir(), DIRECTORY_NAME);
}

export function resolvePendingLicenseEmailActivationPath() {
  return path.join(activationDirectory(), FILE_NAME);
}

function parsePendingLicenseEmailActivation(value: unknown): PendingLicenseEmailActivation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LicenseEmailActivationStorageError('Stored license email activation is invalid.');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.activationId !== 'string'
    || !UUID_PATTERN.test(candidate.activationId)
    || typeof candidate.instanceId !== 'string'
    || candidate.instanceId.length < 8
    || candidate.instanceId.length > 128
    || typeof candidate.pollToken !== 'string'
    || !POLL_TOKEN_PATTERN.test(candidate.pollToken)
    || typeof candidate.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.expiresAt))
    || typeof candidate.pollIntervalSeconds !== 'number'
    || !Number.isSafeInteger(candidate.pollIntervalSeconds)
    || candidate.pollIntervalSeconds < 1
    || candidate.pollIntervalSeconds > 300
    || typeof candidate.createdAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.createdAt))
    || typeof candidate.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.updatedAt))
  ) {
    throw new LicenseEmailActivationStorageError('Stored license email activation is invalid.');
  }
  return candidate as PendingLicenseEmailActivation;
}

async function assertRegularOwnedPath(targetPath: string, expectedType: 'directory' | 'file') {
  let stats;
  try {
    stats = await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const matchesType = expectedType === 'directory' ? stats.isDirectory() : stats.isFile();
  if (stats.isSymbolicLink() || !matchesType) {
    throw new LicenseEmailActivationStorageError('License email activation storage is unsafe.');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new LicenseEmailActivationStorageError('License email activation storage is owned by another operating-system user.');
  }
}

async function ensurePrivateDirectory() {
  const secretsDirectory = resolveSecretsDir();
  const directory = activationDirectory();
  await fs.mkdir(secretsDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertRegularOwnedPath(secretsDirectory, 'directory');
  await fs.chmod(secretsDirectory, PRIVATE_DIRECTORY_MODE);
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertRegularOwnedPath(directory, 'directory');
  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
  return directory;
}

export async function savePendingLicenseEmailActivation(input: {
  activationId: string;
  instanceId: string;
  pollToken: string;
  expiresAt: string;
  pollIntervalSeconds: number;
}) {
  const now = new Date().toISOString();
  const pending = parsePendingLicenseEmailActivation({
    schemaVersion: 1,
    ...input,
    createdAt: now,
    updatedAt: now,
  });
  const directory = await ensurePrivateDirectory();
  const filePath = resolvePendingLicenseEmailActivationPath();
  await assertRegularOwnedPath(filePath, 'file');
  const temporaryPath = path.join(directory, `.${FILE_NAME}.tmp-${process.pid}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(pending, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof LicenseEmailActivationStorageError) throw error;
    throw new LicenseEmailActivationStorageError('License email activation could not be stored securely.');
  }
  return pending;
}

export async function loadPendingLicenseEmailActivation() {
  const filePath = resolvePendingLicenseEmailActivationPath();
  try {
    await assertRegularOwnedPath(filePath, 'file');
    const content = await fs.readFile(filePath, 'utf8');
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
    return parsePendingLicenseEmailActivation(JSON.parse(content) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof LicenseEmailActivationStorageError) throw error;
    throw new LicenseEmailActivationStorageError('Stored license email activation could not be loaded.');
  }
}

export async function removePendingLicenseEmailActivation() {
  await fs.rm(resolvePendingLicenseEmailActivationPath(), { force: true });
}
