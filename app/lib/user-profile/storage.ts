import 'server-only';

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { fileTypeFromBuffer } from 'file-type';

import {
  normalizeDataScopeId,
  resolveUserDataRoot,
} from '@/app/lib/runtime-data-paths';
import { normalizeUserAvatarIconId } from './icon-catalog';
import {
  USER_PROFILE_APPEARANCE_VERSION,
  type UserProfileAppearance,
} from './types';

export const USER_PROFILE_DIRECTORY_NAME = 'profile';
export const USER_PROFILE_APPEARANCE_FILE_NAME = 'appearance.json';
export const USER_PROFILE_AVATAR_FILE_NAME = 'avatar.webp';
export const USER_PROFILE_AVATAR_MAX_STORED_BYTES = 256 * 1024;

const USER_PROFILE_APPEARANCE_MAX_BYTES = 16 * 1024;

export type UserProfileStorageSnapshot = {
  appearance: Buffer | null;
  avatar: Buffer | null;
};

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

export function createDefaultUserProfileAppearance(): UserProfileAppearance {
  return {
    version: USER_PROFILE_APPEARANCE_VERSION,
    avatarKind: 'initials',
    iconId: null,
    revision: 0,
    updatedAt: null,
  };
}

function normalizeUserProfileAppearance(value: unknown): UserProfileAppearance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const avatarKind = record.avatarKind;
  if (avatarKind !== 'image' && avatarKind !== 'icon' && avatarKind !== 'initials') return null;
  const iconId = normalizeUserAvatarIconId(record.iconId);
  if (avatarKind === 'icon' && !iconId) return null;
  const revision = Number(record.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return null;

  return {
    version: USER_PROFILE_APPEARANCE_VERSION,
    avatarKind,
    iconId: avatarKind === 'icon' ? iconId : null,
    revision,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt.trim()
      ? record.updatedAt
      : null,
  };
}

export function resolveUserProfileDirectory(userId: string, cwd?: string): string {
  const normalizedUserId = normalizeDataScopeId(userId, 'userId');
  return path.join(resolveUserDataRoot(normalizedUserId, cwd), USER_PROFILE_DIRECTORY_NAME);
}

export function resolveUserProfileAppearancePath(userId: string, cwd?: string): string {
  return path.join(resolveUserProfileDirectory(userId, cwd), USER_PROFILE_APPEARANCE_FILE_NAME);
}

export function resolveUserProfileAvatarPath(userId: string, cwd?: string): string {
  return path.join(resolveUserProfileDirectory(userId, cwd), USER_PROFILE_AVATAR_FILE_NAME);
}

async function readFileIfExists(filePath: string, maxBytes?: number): Promise<Buffer | null> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size <= 0 || (maxBytes !== undefined && stats.size > maxBytes)) {
      return null;
    }
    return await fs.readFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function writeFileAtomic(filePath: string, buffer: Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, buffer, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function restoreFile(filePath: string, buffer: Buffer | null): Promise<void> {
  if (buffer) {
    await writeFileAtomic(filePath, buffer);
    return;
  }
  await fs.unlink(filePath).catch((error) => {
    if (!isMissingFileError(error)) throw error;
  });
}

export async function readUserProfileAppearance(userId: string): Promise<UserProfileAppearance> {
  const buffer = await readFileIfExists(
    resolveUserProfileAppearancePath(userId),
    USER_PROFILE_APPEARANCE_MAX_BYTES,
  );
  if (!buffer) return createDefaultUserProfileAppearance();
  try {
    return normalizeUserProfileAppearance(JSON.parse(buffer.toString('utf8')))
      ?? createDefaultUserProfileAppearance();
  } catch {
    return createDefaultUserProfileAppearance();
  }
}

export async function writeUserProfileAppearance(
  userId: string,
  appearance: UserProfileAppearance,
): Promise<void> {
  const normalized = normalizeUserProfileAppearance(appearance);
  if (!normalized) throw new Error('Invalid user profile appearance.');
  await writeFileAtomic(
    resolveUserProfileAppearancePath(userId),
    Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8'),
  );
}

export async function readUserProfileAvatar(userId: string): Promise<Buffer | null> {
  const buffer = await readFileIfExists(
    resolveUserProfileAvatarPath(userId),
    USER_PROFILE_AVATAR_MAX_STORED_BYTES,
  );
  if (!buffer) return null;
  const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);
  return detected?.mime === 'image/webp' ? buffer : null;
}

export async function writeUserProfileAvatar(userId: string, buffer: Buffer): Promise<void> {
  if (buffer.length === 0 || buffer.length > USER_PROFILE_AVATAR_MAX_STORED_BYTES) {
    throw new Error('Invalid stored avatar size.');
  }
  const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);
  if (detected?.mime !== 'image/webp') {
    throw new Error('Stored avatar must be a WebP image.');
  }
  await writeFileAtomic(resolveUserProfileAvatarPath(userId), buffer);
}

export async function deleteUserProfileAvatar(userId: string): Promise<void> {
  await fs.unlink(resolveUserProfileAvatarPath(userId)).catch((error) => {
    if (!isMissingFileError(error)) throw error;
  });
}

export async function snapshotUserProfileStorage(userId: string): Promise<UserProfileStorageSnapshot> {
  return {
    appearance: await readFileIfExists(resolveUserProfileAppearancePath(userId)),
    avatar: await readFileIfExists(resolveUserProfileAvatarPath(userId)),
  };
}

export async function restoreUserProfileStorage(
  userId: string,
  snapshot: UserProfileStorageSnapshot,
): Promise<void> {
  await restoreFile(resolveUserProfileAppearancePath(userId), snapshot.appearance);
  await restoreFile(resolveUserProfileAvatarPath(userId), snapshot.avatar);
}
