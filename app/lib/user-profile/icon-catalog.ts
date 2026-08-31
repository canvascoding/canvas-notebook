export const USER_AVATAR_ICON_IDS = [
  'user-round',
  'smile',
  'sparkles',
  'rocket',
  'palette',
  'code-2',
  'book-open',
  'camera',
  'music',
  'coffee',
  'mountain',
  'leaf',
] as const;

export type UserAvatarIconId = typeof USER_AVATAR_ICON_IDS[number];

const USER_AVATAR_ICON_ID_SET = new Set<string>(USER_AVATAR_ICON_IDS);

export function normalizeUserAvatarIconId(value: unknown): UserAvatarIconId | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return USER_AVATAR_ICON_ID_SET.has(normalized)
    ? normalized as UserAvatarIconId
    : null;
}
