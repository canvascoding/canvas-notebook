import 'server-only';

import { isAdminUser, type AdminUserCandidate } from '@/app/lib/admin-auth';

export type ServerSettingsUpdatePermission =
  | { ok: true; reason: 'admin' | 'onboarding' }
  | { ok: false; reason: 'admin_required' };

export function resolveServerSettingsUpdatePermission(
  user: AdminUserCandidate | null | undefined,
  state: { onboardingEnabled: boolean; onboardingComplete: boolean },
): ServerSettingsUpdatePermission {
  if (isAdminUser(user)) {
    return { ok: true, reason: 'admin' };
  }

  if (state.onboardingEnabled && !state.onboardingComplete) {
    return { ok: true, reason: 'onboarding' };
  }

  return { ok: false, reason: 'admin_required' };
}
