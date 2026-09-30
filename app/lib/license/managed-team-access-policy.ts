import 'server-only';

import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';
import { readSettingsTextFileIfExists, writeSettingsJsonFileAtomic } from '@/app/lib/settings-storage';

const STORAGE_FILE = 'managed-team-access-policy.json';
const STORAGE_LOCK = 'managed-team-access-policy';

export type ManagedTeamAccessPolicy = {
  state: 'active' | 'grace' | 'restricted';
  reason: 'grant_expired' | 'grant_revoked' | null;
  graceEndsAt: string | null;
  allowNewMembers: boolean;
};

type StoredPolicy = ManagedTeamAccessPolicy & {
  version: 1;
  instanceId: string;
  entitlementsVersion: number;
};

export async function readManagedTeamAccessPolicy(instanceId: string): Promise<ManagedTeamAccessPolicy | null> {
  const { content } = await readSettingsTextFileIfExists(STORAGE_FILE);
  if (!content) return null;
  try {
    const stored = JSON.parse(content) as StoredPolicy;
    if (stored.version !== 1 || stored.instanceId !== instanceId
      || !Number.isSafeInteger(stored.entitlementsVersion)
      || !['active', 'grace', 'restricted'].includes(stored.state)
      || ![null, 'grant_expired', 'grant_revoked'].includes(stored.reason)
      || typeof stored.allowNewMembers !== 'boolean') return null;
    return {
      state: stored.state,
      reason: stored.reason,
      graceEndsAt: stored.graceEndsAt,
      allowNewMembers: stored.allowNewMembers,
    };
  } catch {
    return null;
  }
}

export async function recordManagedTeamAccessPolicy(input: {
  instanceId: string;
  entitlementsVersion: number;
  policy: ManagedTeamAccessPolicy;
}): Promise<void> {
  await withKeyedOperationLock(STORAGE_LOCK, STORAGE_FILE, async () => {
    const { content } = await readSettingsTextFileIfExists(STORAGE_FILE);
    if (content) {
      try {
        const prior = JSON.parse(content) as StoredPolicy;
        if (prior.version === 1 && prior.instanceId === input.instanceId
          && Number.isSafeInteger(prior.entitlementsVersion)
          && prior.entitlementsVersion > input.entitlementsVersion) return;
      } catch {}
    }
    await writeSettingsJsonFileAtomic(STORAGE_FILE, {
      version: 1,
      instanceId: input.instanceId,
      entitlementsVersion: input.entitlementsVersion,
      ...input.policy,
    } satisfies StoredPolicy);
  });
}
