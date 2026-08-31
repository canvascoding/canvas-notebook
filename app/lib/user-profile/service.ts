import 'server-only';

import { eq } from 'drizzle-orm';

import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';
import { db } from '@/app/lib/db';
import { user } from '@/app/lib/db/schema';
import { getUserInitials } from './initials';
import {
  normalizeUserAvatarIconId,
  type UserAvatarIconId,
} from './icon-catalog';
import {
  deleteUserProfileAvatar,
  readUserProfileAppearance,
  readUserProfileAvatar,
  restoreUserProfileStorage,
  snapshotUserProfileStorage,
  writeUserProfileAppearance,
  writeUserProfileAvatar,
} from './storage';
import type {
  ResolvedUserProfile,
  UserAvatarKind,
  UserProfileAppearance,
} from './types';

const USER_PROFILE_WRITE_LOCK_NAMESPACE = 'user-profile-write';

export class UserProfileError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'UserProfileError';
  }
}

function nextAppearance(
  current: UserProfileAppearance,
  input: { avatarKind: UserAvatarKind; iconId?: UserAvatarIconId | null },
): UserProfileAppearance {
  return {
    version: 1,
    avatarKind: input.avatarKind,
    iconId: input.avatarKind === 'icon' ? input.iconId ?? null : null,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}

function profileImageUrl(revision: number): string {
  return `/api/account/profile/avatar?v=${revision}`;
}

async function readDatabaseImage(userId: string): Promise<string | null> {
  const rows = await db
    .select({ image: user.image })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!rows[0]) throw new UserProfileError('User profile not found.', 404);
  return rows[0].image ?? null;
}

async function updateDatabaseImage(userId: string, image: string | null): Promise<void> {
  await db
    .update(user)
    .set({ image, updatedAt: new Date() })
    .where(eq(user.id, userId));
}

export async function resolveUserProfile(input: {
  userId: string;
  name?: string | null;
  email?: string | null;
  locale?: string;
}): Promise<ResolvedUserProfile> {
  const appearance = await readUserProfileAppearance(input.userId);
  const imageAvailable = appearance.avatarKind === 'image'
    ? Boolean(await readUserProfileAvatar(input.userId))
    : false;
  const iconId = appearance.avatarKind === 'icon'
    ? normalizeUserAvatarIconId(appearance.iconId)
    : null;
  const avatarKind: UserAvatarKind = imageAvailable
    ? 'image'
    : iconId ? 'icon' : 'initials';
  const name = input.name?.trim() || input.email?.trim() || 'User';

  return {
    name,
    avatarKind,
    iconId: avatarKind === 'icon' ? iconId : null,
    initials: getUserInitials({ name, email: input.email, locale: input.locale }),
    imageUrl: avatarKind === 'image' ? profileImageUrl(appearance.revision) : null,
    revision: appearance.revision,
  };
}

async function runProfileMutation(
  userId: string,
  operation: (current: UserProfileAppearance) => Promise<UserProfileAppearance>,
): Promise<UserProfileAppearance> {
  return withKeyedOperationLock(USER_PROFILE_WRITE_LOCK_NAMESPACE, userId, async () => {
    const previousDatabaseImage = await readDatabaseImage(userId);
    const storageSnapshot = await snapshotUserProfileStorage(userId);
    const current = await readUserProfileAppearance(userId);
    try {
      return await operation(current);
    } catch (error) {
      await restoreUserProfileStorage(userId, storageSnapshot).catch((restoreError) => {
        console.error('[UserProfile] Failed to restore profile storage after a mutation error.', restoreError);
      });
      await updateDatabaseImage(userId, previousDatabaseImage).catch((restoreError) => {
        console.error('[UserProfile] Failed to restore profile metadata after a mutation error.', restoreError);
      });
      throw error;
    }
  });
}

export async function saveUserProfileImage(input: {
  userId: string;
  buffer: Buffer;
}): Promise<UserProfileAppearance> {
  return runProfileMutation(input.userId, async (current) => {
    const appearance = nextAppearance(current, { avatarKind: 'image' });
    await writeUserProfileAvatar(input.userId, input.buffer);
    await writeUserProfileAppearance(input.userId, appearance);
    await updateDatabaseImage(input.userId, profileImageUrl(appearance.revision));
    return appearance;
  });
}

export async function selectUserProfileIcon(input: {
  userId: string;
  iconId: unknown;
}): Promise<UserProfileAppearance> {
  const iconId = normalizeUserAvatarIconId(input.iconId);
  if (!iconId) throw new UserProfileError('Unsupported profile icon.');

  return runProfileMutation(input.userId, async (current) => {
    const appearance = nextAppearance(current, { avatarKind: 'icon', iconId });
    await deleteUserProfileAvatar(input.userId);
    await writeUserProfileAppearance(input.userId, appearance);
    await updateDatabaseImage(input.userId, null);
    return appearance;
  });
}

export async function selectUserProfileInitials(userId: string): Promise<UserProfileAppearance> {
  return runProfileMutation(userId, async (current) => {
    const appearance = nextAppearance(current, { avatarKind: 'initials' });
    await deleteUserProfileAvatar(userId);
    await writeUserProfileAppearance(userId, appearance);
    await updateDatabaseImage(userId, null);
    return appearance;
  });
}

export async function readUserProfileImage(userId: string): Promise<{
  buffer: Buffer;
  revision: number;
  updatedAt: string | null;
} | null> {
  const [appearance, buffer] = await Promise.all([
    readUserProfileAppearance(userId),
    readUserProfileAvatar(userId),
  ]);
  if (appearance.avatarKind !== 'image' || !buffer) return null;
  return { buffer, revision: appearance.revision, updatedAt: appearance.updatedAt };
}
