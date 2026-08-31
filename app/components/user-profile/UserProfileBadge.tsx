'use client';

import { useTranslations } from 'next-intl';

import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { UserAvatar } from './UserAvatar';

export function UserProfileBadge({
  profile,
  href = '/settings',
  className,
}: {
  profile: ResolvedUserProfile;
  href?: string;
  className?: string;
}) {
  const t = useTranslations('userProfile');

  return (
    <Link
      href={href}
      aria-label={t('profileLinkLabel', { name: profile.name })}
      className={cn(
        'group inline-flex min-w-0 items-center gap-2 rounded-xl px-2 py-1.5',
        'text-sm font-medium outline-none transition-colors hover:bg-accent',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
    >
      <UserAvatar profile={profile} className="size-9 transition-transform group-hover:scale-[1.03]" />
      <span className="hidden max-w-40 truncate sm:inline">{profile.name}</span>
    </Link>
  );
}
