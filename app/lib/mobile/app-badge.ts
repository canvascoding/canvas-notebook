import 'server-only';

import { eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { user } from '@/app/lib/db/schema';

import { getMobileInboxCategoryCounts } from './inbox-counts';
import { loadMobileInboxScope } from './inbox-scope';

type MobileAppBadgeUser = {
  id: string;
  email?: string | null;
  role?: string | null;
};

/**
 * Counts the badge-eligible notification categories for the app icon within
 * the user's currently accessible workspaces. E-mail attention and open To-dos
 * intentionally remain tab-local counts.
 */
export async function countMobileAppBadge(currentUser: MobileAppBadgeUser): Promise<number> {
  const scope = await loadMobileInboxScope(currentUser);
  const counts = await getMobileInboxCategoryCounts({
    userId: currentUser.id,
    workspaces: scope.availableWorkspaces,
  });
  return counts.notifications.badge;
}

export async function countMobileAppBadgeForUserId(userId: string): Promise<number> {
  const [currentUser] = await db.select({
    id: user.id,
    email: user.email,
    role: user.role,
  }).from(user).where(eq(user.id, userId)).limit(1);
  return currentUser ? countMobileAppBadge(currentUser) : 0;
}
