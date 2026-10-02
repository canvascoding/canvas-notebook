import type { APIRequestContext } from '@playwright/test';
import { setTimeout as wait } from 'node:timers/promises';

import { ownedCollaborationQaEnabled, requireOwnedCollaborationQaTarget } from '../../scripts/lib/owned-collaboration-qa';

/** One quiet rate-limit window before the owned QA group opens any Notebook pages. */
export async function waitForOwnedNotificationSummaryBudget(api: APIRequestContext): Promise<void> {
  if (!ownedCollaborationQaEnabled()) return;
  const target = await requireOwnedCollaborationQaTarget();
  await wait(61_000);
  const response = await api.get(new URL('/api/notifications/summary', target.baseURL).href, { timeout: 15_000 });
  if (response.status() !== 200) {
    const retryAfter = response.status() === 429 ? response.headers()['retry-after'] : undefined;
    const hint = retryAfter && /^\d+$/u.test(retryAfter) ? `; retry after ${retryAfter}s` : '';
    throw new Error(`Notification summary failed after the QA quiet window (${response.status()}${hint}).`);
  }
  const payload = await response.json().catch(() => {
    throw new Error('Notification summary returned invalid JSON after the QA quiet window.');
  }) as { success?: boolean; data?: { unreadCount?: unknown; counts?: Record<string, unknown>; items?: unknown } } | null;
  const data = payload?.data;
  const counts = data?.counts;
  const countKeys = ['unread', 'chat', 'todos', 'todoUnread', 'studio', 'automation'];
  if (payload?.success !== true || !Number.isSafeInteger(data?.unreadCount) || Number(data?.unreadCount) < 0
    || !counts || typeof counts !== 'object' || Array.isArray(counts)
    || !countKeys.every((key) => Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0)
    || data?.unreadCount !== counts.unread || !Array.isArray(data?.items)) {
    throw new Error('Notification summary returned an invalid success/count shape after the QA quiet window.');
  }
}
