'use client';

import { useState, type ComponentType, type SVGProps } from 'react';
import {
  BookOpen,
  Camera,
  Code2,
  Coffee,
  Leaf,
  Mountain,
  Music2,
  Palette,
  Rocket,
  Smile,
  Sparkles,
  UserRound,
} from 'lucide-react';

import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';
import type { UserAvatarIconId } from '@/app/lib/user-profile/icon-catalog';
import { cn } from '@/lib/utils';

type AvatarIcon = ComponentType<SVGProps<SVGSVGElement>>;

export const USER_AVATAR_ICONS: Record<UserAvatarIconId, AvatarIcon> = {
  'user-round': UserRound,
  smile: Smile,
  sparkles: Sparkles,
  rocket: Rocket,
  palette: Palette,
  'code-2': Code2,
  'book-open': BookOpen,
  camera: Camera,
  music: Music2,
  coffee: Coffee,
  mountain: Mountain,
  leaf: Leaf,
};

export function UserAvatar({
  profile,
  className,
  iconClassName,
}: {
  profile: ResolvedUserProfile;
  className?: string;
  iconClassName?: string;
}) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const Icon = profile.iconId
    ? USER_AVATAR_ICONS[profile.iconId as UserAvatarIconId]
    : undefined;
  const showImage = profile.avatarKind === 'image'
    && Boolean(profile.imageUrl)
    && failedImageUrl !== profile.imageUrl;

  return (
    <span
      className={cn(
        'relative inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl',
        'border border-border/70 bg-gradient-to-br from-primary/15 via-background to-accent text-foreground shadow-sm',
        className,
      )}
      data-avatar-kind={showImage ? 'image' : profile.avatarKind}
    >
      {showImage ? (
        // The file is already normalized server-side; an img element also lets us fall back on load errors.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          className="size-full object-cover"
          src={profile.imageUrl ?? undefined}
          onError={() => setFailedImageUrl(profile.imageUrl)}
        />
      ) : profile.avatarKind === 'icon' && Icon ? (
        <Icon aria-hidden="true" className={cn('size-1/2', iconClassName)} strokeWidth={1.8} />
      ) : profile.initials ? (
        <span className="select-none text-[0.38em] font-semibold uppercase tracking-[0.08em]">
          {profile.initials}
        </span>
      ) : (
        <UserRound aria-hidden="true" className={cn('size-1/2', iconClassName)} strokeWidth={1.8} />
      )}
    </span>
  );
}
