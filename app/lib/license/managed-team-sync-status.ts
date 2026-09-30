import 'server-only';

import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';
import { readSettingsTextFileIfExists, writeSettingsJsonFileAtomic } from '@/app/lib/settings-storage';

const STORAGE_FILE = 'managed-team-sync-status.json';

export type ManagedTeamSyncError = {
  code: string;
  endpoint: string | null;
  httpStatus: number | null;
};

export type ManagedTeamSyncStatus = {
  version: 1;
  instanceId: string;
  organizationId: string | null;
  state: 'adoption_required' | 'pending' | 'current' | 'error';
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextAttemptAt: number | null;
  membershipRevision: number | null;
  entitlementsVersion: number | null;
  approvedMemberCount: number | null;
  observedMemberCount: number | null;
  seatLimit: number | null;
  termEndsAt: string | null;
  accessPolicyState?: 'active' | 'grace' | 'restricted' | null;
  accessPolicyReason?: 'grant_expired' | 'grant_revoked' | null;
  graceEndsAt?: string | null;
  lastError: ManagedTeamSyncError | null;
};

export async function readManagedTeamSyncStatus(instanceId: string): Promise<ManagedTeamSyncStatus | null> {
  const { content } = await readSettingsTextFileIfExists(STORAGE_FILE);
  if (!content) return null;
  try {
    const status = JSON.parse(content) as ManagedTeamSyncStatus;
    if (status.version !== 1 || status.instanceId !== instanceId
      || !['adoption_required', 'pending', 'current', 'error'].includes(status.state)
      || ![status.lastAttemptAt, status.lastSuccessAt, status.nextAttemptAt,
        status.membershipRevision, status.entitlementsVersion, status.approvedMemberCount,
        status.observedMemberCount, status.seatLimit].every((value) => value === null
          || (Number.isSafeInteger(value) && value >= 0))
      || (status.organizationId !== null && typeof status.organizationId !== 'string')
      || (status.termEndsAt !== null && (typeof status.termEndsAt !== 'string'
        || !Number.isFinite(Date.parse(status.termEndsAt))))
      || (status.accessPolicyState != null && !['active', 'grace', 'restricted'].includes(status.accessPolicyState))
      || (status.accessPolicyReason != null && !['grant_expired', 'grant_revoked'].includes(status.accessPolicyReason))
      || (status.graceEndsAt != null && (typeof status.graceEndsAt !== 'string'
        || !Number.isFinite(Date.parse(status.graceEndsAt))))
      || (status.lastError !== null && (!status.lastError
        || !/^[A-Z][A-Z0-9_]{0,99}$/.test(status.lastError.code)
        || (status.lastError.endpoint !== null && !/^\/v1\/managed\/team\/[a-z/-]+$/.test(status.lastError.endpoint))
        || (status.lastError.httpStatus !== null && (!Number.isInteger(status.lastError.httpStatus)
          || status.lastError.httpStatus < 100 || status.lastError.httpStatus > 599))))) return null;
    return status;
  } catch {
    return null;
  }
}

export async function recordManagedTeamSyncStatus(
  instanceId: string,
  patch: Partial<Omit<ManagedTeamSyncStatus, 'version' | 'instanceId'>>,
): Promise<void> {
  await withKeyedOperationLock('managed-team-sync-status', STORAGE_FILE, async () => {
    const stored = await readManagedTeamSyncStatus(instanceId);
    const prior = patch.organizationId && stored?.organizationId !== patch.organizationId ? null : stored;
    await writeSettingsJsonFileAtomic(STORAGE_FILE, {
      version: 1, instanceId, organizationId: null, state: 'pending',
      lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null,
      membershipRevision: null, entitlementsVersion: null, approvedMemberCount: null,
      observedMemberCount: null, seatLimit: null, termEndsAt: null, lastError: null,
      accessPolicyState: null, accessPolicyReason: null, graceEndsAt: null,
      ...prior, ...patch,
    } satisfies ManagedTeamSyncStatus);
  });
}

export function managedTeamSyncError(error: unknown): ManagedTeamSyncError {
  const value = error instanceof Error ? error : null;
  const details = value as (Error & { endpoint?: string; httpStatus?: number }) | null;
  return {
    code: value && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.message)
      ? value.message : 'MANAGED_TEAM_SYNC_FAILED',
    endpoint: details?.endpoint && /^\/v1\/managed\/team\/[a-z/-]+$/.test(details.endpoint)
      ? details.endpoint : null,
    httpStatus: details?.httpStatus && Number.isInteger(details.httpStatus)
      && details.httpStatus >= 100 && details.httpStatus <= 599 ? details.httpStatus : null,
  };
}
