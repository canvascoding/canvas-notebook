'use client';

import { useTranslations } from 'next-intl';
import { ChevronDown, Settings } from 'lucide-react';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { LogoutButton } from '@/app/components/LogoutButton';
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
  const tSettings = useTranslations('home.apps.settings');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('profileMenuLabel', { name: profile.name })}
          className={cn(
            'group inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-xl px-1.5 py-1 sm:gap-2 sm:px-2',
            'text-sm font-medium outline-none transition-colors hover:bg-accent data-[state=open]:bg-accent',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            className,
          )}
        >
          <UserAvatar profile={profile} className="size-9" />
          <span className="hidden max-w-32 truncate sm:inline">{profile.name}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} collisionPadding={12} className="w-56 max-w-[calc(100vw-1.5rem)]">
        <DropdownMenuLabel className="break-words">{profile.name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="min-h-10 cursor-pointer">
          <Link href={href}><Settings aria-hidden="true" />{tSettings('title')}</Link>
        </DropdownMenuItem>
        <LogoutButton asMenuItem />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
