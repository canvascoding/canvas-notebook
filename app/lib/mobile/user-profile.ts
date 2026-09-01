import 'server-only';

import { resolveUserProfile } from '@/app/lib/user-profile/service';
import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';

export const MOBILE_ACCOUNT_PROFILE_PATH = '/api/mobile/v1/account/profile' as const;
export const MOBILE_ACCOUNT_PROFILE_AVATAR_PATH = '/api/mobile/v1/account/profile/avatar' as const;

export type MobileUserProfile = Omit<ResolvedUserProfile, 'imageUrl'> & {
  imagePath: string | null;
};

export function mobileUserProfileAvatarPath(revision: number): string {
  return `${MOBILE_ACCOUNT_PROFILE_AVATAR_PATH}?v=${revision}`;
}

export function serializeMobileUserProfile(profile: ResolvedUserProfile): MobileUserProfile {
  return {
    name: profile.name,
    avatarKind: profile.avatarKind,
    iconId: profile.iconId,
    initials: profile.initials,
    imagePath: profile.avatarKind === 'image'
      ? mobileUserProfileAvatarPath(profile.revision)
      : null,
    revision: profile.revision,
  };
}

export async function resolveMobileUserProfile(input: {
  userId: string;
  name?: string | null;
  email?: string | null;
  locale?: string;
}): Promise<MobileUserProfile> {
  return serializeMobileUserProfile(await resolveUserProfile(input));
}
