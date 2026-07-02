import 'server-only';

import { isAdminUser, type AdminUserCandidate } from '@/app/lib/admin-auth';

export type ServerSettingsUpdatePermission =
  | { ok: true; reason: 'admin' | 'onboarding' }
  | { ok: false; reason: 'admin_required' };

export function resolveServerSettingsUpdatePermission(
  user: AdminUserCandidate | null | undefined,
  state: { onboardingEnabled: boolean; onboardingComplete: boolean },
): ServerSettingsUpdatePermission {
  const adminCheck = isAdminUser(user);
  console.log('[server-settings-policy] Permission check:', {
    userRole: user?.role,
    userEmail: user?.email,
    isAdmin: adminCheck,
    onboardingEnabled: state.onboardingEnabled,
    onboardingComplete: state.onboardingComplete,
  });

  if (adminCheck) {
    return { ok: true, reason: 'admin' };
  }

  if (state.onboardingEnabled && !state.onboardingComplete) {
    return { ok: true, reason: 'onboarding' };
  }

  console.warn('[server-settings-policy] Permission denied:', {
    userRole: user?.role,
    userEmail: user?.email,
    onboardingEnabled: state.onboardingEnabled,
    onboardingComplete: state.onboardingComplete,
  });
  return { ok: false, reason: 'admin_required' };
}
