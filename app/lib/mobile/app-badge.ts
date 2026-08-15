import 'server-only';

import { eq } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { user } from '@/app/lib/db/schema';

import { countMobileUnreadMessages } from './inbox';
import { loadMobileInboxScope } from './inbox-scope';

type MobileAppBadgeUser = {
  id: string;
  email?: string | null;
  role?: string | null;
};

/**
 * Counts unread agent responses for the app icon within the user's currently
 * accessible workspaces. The per-workspace Inbox baseline prevents historic
 * responses from becoming new badges when the feature is first enabled.
 */
export async function countMobileAppBadge(currentUser: MobileAppBadgeUser): Promise<number> {
  const scope = await loadMobileInboxScope(currentUser);
  return countMobileUnreadMessages({
    userId: currentUser.id,
    workspaces: scope.availableWorkspaces,
  });
}

export async function countMobileAppBadgeForUserId(userId: string): Promise<number> {
  const [currentUser] = await db.select({
    id: user.id,
    email: user.email,
    role: user.role,
  }).from(user).where(eq(user.id, userId)).limit(1);
  return currentUser ? countMobileAppBadge(currentUser) : 0;
}
