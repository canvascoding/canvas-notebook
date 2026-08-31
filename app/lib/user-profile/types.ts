export const USER_PROFILE_APPEARANCE_VERSION = 1 as const;

export type UserAvatarKind = 'image' | 'icon' | 'initials';

export type UserProfileAppearance = {
  version: typeof USER_PROFILE_APPEARANCE_VERSION;
  avatarKind: UserAvatarKind;
  iconId: string | null;
  revision: number;
  updatedAt: string | null;
};

export type ResolvedUserProfile = {
  name: string;
  avatarKind: UserAvatarKind;
  iconId: string | null;
  initials: string;
  imageUrl: string | null;
  revision: number;
};
