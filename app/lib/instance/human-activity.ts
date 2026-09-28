import 'server-only';

import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';
import { readSettingsTextFileIfExists, writeSettingsJsonFileAtomic } from '@/app/lib/settings-storage';
import { HUMAN_ACTIVITY_INTERVAL_MS } from './human-activity-policy';

const STORAGE_FILE = 'human-activity.json';
const STORAGE_LOCK = 'human-activity-write';

export async function lastHumanActivityAt(): Promise<string | null> {
  const { content } = await readSettingsTextFileIfExists(STORAGE_FILE);
  if (!content) return null;
  try {
    const value = JSON.parse(content) as { lastHumanActivityAt?: unknown };
    if (typeof value.lastHumanActivityAt !== 'string') return null;
    const timestamp = Date.parse(value.lastHumanActivityAt);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  } catch {
    return null;
  }
}

export async function recordHumanActivity(now = new Date()): Promise<{ recorded: boolean; lastHumanActivityAt: string }> {
  return withKeyedOperationLock(STORAGE_LOCK, STORAGE_FILE, async () => {
    const previous = await lastHumanActivityAt();
    const current = now.getTime();
    if (!Number.isFinite(current)) throw new Error('Invalid human activity time.');
    if (previous && current - Date.parse(previous) < HUMAN_ACTIVITY_INTERVAL_MS) {
      return { recorded: false, lastHumanActivityAt: previous };
    }
    const timestamp = new Date(current).toISOString();
    await writeSettingsJsonFileAtomic(STORAGE_FILE, { version: 1, lastHumanActivityAt: timestamp });
    return { recorded: true, lastHumanActivityAt: timestamp };
  });
}
