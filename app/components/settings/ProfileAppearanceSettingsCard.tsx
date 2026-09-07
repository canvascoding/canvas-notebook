'use client';

import { useState } from 'react';
import { ChevronRight, Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { ProfileAppearanceEditor } from '@/app/components/user-profile/ProfileAppearanceEditor';
import { UserAvatar } from '@/app/components/user-profile/UserAvatar';
import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export function ProfileAppearanceSettingsCard({
  initialProfile,
}: {
  initialProfile: ResolvedUserProfile;
}) {
  const t = useTranslations('userProfile');
  const [profile, setProfile] = useState(initialProfile);

  return (
    <Dialog>
      <Card className="gap-0 overflow-hidden py-0">
        <DialogTrigger asChild>
          <button
            type="button"
            className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 sm:px-5"
          >
            <span className="relative shrink-0">
              <UserAvatar profile={profile} className="size-11 text-base shadow-sm" />
              <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full border-2 border-card bg-foreground text-background shadow-sm transition-transform group-hover:scale-105">
                <Pencil aria-hidden="true" className="size-2.5" strokeWidth={2.5} />
              </span>
            </span>

            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{t('title')}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {profile.name} · {t('editHint')}
              </span>
            </span>

            <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
              <span className="hidden sm:inline">{t('edit')}</span>
              <ChevronRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>
        </DialogTrigger>
      </Card>

      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12 sm:px-6">
          <DialogTitle>{t('editTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto p-3 sm:p-5">
          <ProfileAppearanceEditor
            initialProfile={profile}
            onProfileChange={setProfile}
            className="rounded-xl shadow-none"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
