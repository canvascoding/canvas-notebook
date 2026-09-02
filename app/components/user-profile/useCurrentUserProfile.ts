'use client';

import { useEffect, useState } from 'react';

import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';

type UserProfileResponse = {
  success?: boolean;
  data?: ResolvedUserProfile;
};

export function useCurrentUserProfile(): ResolvedUserProfile | null {
  const [profile, setProfile] = useState<ResolvedUserProfile | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const loadProfile = async () => {
      try {
        const response = await fetch('/api/account/profile', {
          cache: 'no-store',
          credentials: 'include',
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as UserProfileResponse | null;
        if (response.ok && payload?.success && payload.data) {
          setProfile(payload.data);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.warn('[UserProfile] Failed to load the current profile for chat.', error);
        }
      }
    };

    void loadProfile();
    return () => controller.abort();
  }, []);

  return profile;
}
