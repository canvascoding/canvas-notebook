'use client';

import { DragEvent, useRef, useState } from 'react';
import { Check, ImagePlus, Loader2, Type } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { USER_AVATAR_ICON_IDS, type UserAvatarIconId } from '@/app/lib/user-profile/icon-catalog';
import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { UserAvatar } from './UserAvatar';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ACCEPTED_UPLOAD_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

type ProfileResponse = {
  success?: boolean;
  data?: ResolvedUserProfile;
  error?: string;
};

async function readProfileResponse(response: Response): Promise<ResolvedUserProfile> {
  const body = await response.json().catch(() => ({})) as ProfileResponse;
  if (!response.ok || !body.success || !body.data) {
    throw new Error(body.error || `Profile update failed (${response.status}).`);
  }
  return body.data;
}

export function ProfileAppearanceEditor({
  initialProfile,
  className,
}: {
  initialProfile: ResolvedUserProfile;
  className?: string;
}) {
  const t = useTranslations('userProfile');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState(initialProfile);
  const [pendingChoice, setPendingChoice] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const updateChoice = async (avatarKind: 'icon' | 'initials', iconId?: UserAvatarIconId) => {
    if (pendingChoice) return;
    const choice = iconId ?? avatarKind;
    setPendingChoice(choice);
    try {
      const response = await fetch('/api/account/profile', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarKind, ...(iconId ? { iconId } : {}) }),
      });
      setProfile(await readProfileResponse(response));
      toast.success(iconId ? t('iconUpdated') : t('initialsUpdated'));
    } catch (error) {
      console.warn('[UserProfile] Failed to update avatar choice.', error);
      toast.error(t('updateFailed'));
    } finally {
      setPendingChoice(null);
    }
  };

  const uploadImage = async (file: File | undefined) => {
    if (!file || pendingChoice) return;
    if (!ACCEPTED_UPLOAD_TYPES.has(file.type)) {
      toast.error(t('invalidFile'));
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(t('fileTooLarge'));
      return;
    }

    setPendingChoice('image');
    try {
      const formData = new FormData();
      formData.set('avatar', file);
      const response = await fetch('/api/account/profile/avatar', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      setProfile(await readProfileResponse(response));
      toast.success(t('imageUpdated'));
    } catch (error) {
      console.warn('[UserProfile] Failed to upload avatar image.', error);
      toast.error(t('updateFailed'));
    } finally {
      setPendingChoice(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files.length !== 1) {
      toast.error(t('singleFileOnly'));
      return;
    }
    void uploadImage(event.dataTransfer.files[0]);
  };

  const isBusy = Boolean(pendingChoice);

  return (
    <section
      className={cn('overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm', className)}
      aria-labelledby="profile-appearance-title"
    >
      <div className="grid md:grid-cols-[minmax(220px,0.8fr)_minmax(300px,1.2fr)]">
        <div className="relative flex min-h-52 flex-col justify-between overflow-hidden border-b bg-muted/25 p-6 md:border-r md:border-b-0">
          <div className="pointer-events-none absolute -top-16 -right-16 size-48 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative">
            <p className="mb-4 text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              {t('previewLabel')}
            </p>
            <UserAvatar profile={profile} className="size-20 text-4xl" />
          </div>
          <div className="relative mt-6 min-w-0">
            <p className="truncate text-lg font-semibold">{profile.name}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('shownAs')}</p>
          </div>
        </div>

        <div className="space-y-7 p-6">
          <header>
            <h2 id="profile-appearance-title" className="text-base font-semibold">{t('title')}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('description')}</p>
          </header>

          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">{t('uploadTitle')}</h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t('uploadDescription')}</p>
            </div>
            <div
              className={cn(
                'flex min-h-24 items-center justify-between gap-4 rounded-xl border border-dashed p-4 transition-colors',
                isDragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/15 hover:bg-muted/30',
              )}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-background shadow-sm ring-1 ring-border">
                  <ImagePlus aria-hidden="true" className="size-5 text-muted-foreground" />
                </span>
                <p className="text-sm text-muted-foreground">{t('dropImage')}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                {pendingChoice === 'image' ? <Loader2 className="animate-spin" /> : <ImagePlus />}
                {profile.avatarKind === 'image' ? t('replaceImage') : t('chooseImage')}
              </Button>
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif"
                onChange={(event) => void uploadImage(event.target.files?.[0])}
              />
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">{t('iconsTitle')}</h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t('iconsDescription')}</p>
            </div>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6" role="group" aria-label={t('iconsTitle')}>
              {USER_AVATAR_ICON_IDS.map((iconId) => {
                const isSelected = profile.avatarKind === 'icon' && profile.iconId === iconId;
                return (
                  <button
                    key={iconId}
                    type="button"
                    disabled={isBusy}
                    aria-label={t(`icons.${iconId}`)}
                    aria-pressed={isSelected}
                    className={cn(
                      'group relative flex aspect-square items-center justify-center rounded-xl border outline-none transition-all',
                      'hover:-translate-y-0.5 hover:border-primary/50 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                      'disabled:pointer-events-none disabled:opacity-50',
                      isSelected ? 'border-primary bg-primary/8 shadow-sm' : 'border-border bg-background',
                    )}
                    onClick={() => void updateChoice('icon', iconId)}
                  >
                    <UserAvatar
                      profile={{ ...profile, avatarKind: 'icon', iconId, imageUrl: null }}
                      className="size-10 border-0 bg-transparent shadow-none"
                    />
                    {pendingChoice === iconId ? (
                      <Loader2 className="absolute top-1 right-1 size-3 animate-spin text-primary" />
                    ) : isSelected ? (
                      <Check className="absolute top-1 right-1 size-3 text-primary" strokeWidth={3} />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-xl bg-muted/35 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border">
                <Type aria-hidden="true" className="size-4 text-muted-foreground" />
              </span>
              <div>
                <p className="text-sm font-medium">{t('initialsTitle')}</p>
                <p className="text-xs leading-5 text-muted-foreground">{t('initialsDescription')}</p>
              </div>
            </div>
            <Button
              type="button"
              variant={profile.avatarKind === 'initials' ? 'secondary' : 'outline'}
              size="sm"
              disabled={isBusy}
              onClick={() => void updateChoice('initials')}
            >
              {pendingChoice === 'initials' ? <Loader2 className="animate-spin" /> : null}
              {profile.avatarKind === 'initials' ? t('selected') : t('useInitials')}
            </Button>
          </div>

          <p className="sr-only" aria-live="polite">
            {pendingChoice ? t('saving') : ''}
          </p>
        </div>
      </div>
    </section>
  );
}
