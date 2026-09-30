import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main() {
  const folder = await mkdtemp(path.join(tmpdir(), 'managed-sync-health-'));
  const previous = process.env.DATA;
  process.env.DATA = folder;
  try {
    const { readManagedTeamSyncStatus, recordManagedTeamSyncStatus, managedTeamSyncError } = await import('../app/lib/license/managed-team-sync-status');
    await recordManagedTeamSyncStatus('instance-a', { organizationId: 'local-a', state: 'current', lastSuccessAt: 100, seatLimit: 10, approvedMemberCount: 2, accessPolicyState: 'grace', accessPolicyReason: 'grant_expired', graceEndsAt: '2026-10-01T00:00:00.000Z' });
    assert.equal((await readManagedTeamSyncStatus('instance-a'))?.lastSuccessAt, 100);
    assert.equal(await readManagedTeamSyncStatus('instance-b'), null);
    await recordManagedTeamSyncStatus('instance-a', { state: 'error', lastError: { code: 'ACK_FAILED', endpoint: '/v1/managed/team/sync/ack', httpStatus: 503 } });
    assert.equal((await readManagedTeamSyncStatus('instance-a'))?.lastSuccessAt, 100);
    await recordManagedTeamSyncStatus('instance-a', { organizationId: 'local-b' });
    assert.equal((await readManagedTeamSyncStatus('instance-a'))?.lastSuccessAt, null);
    assert.equal((await readManagedTeamSyncStatus('instance-a'))?.seatLimit, null);
    assert.equal((await readManagedTeamSyncStatus('instance-a'))?.accessPolicyState, null);
    assert.deepEqual(managedTeamSyncError(new Error('secret token and email@example.com')), { code: 'MANAGED_TEAM_SYNC_FAILED', endpoint: null, httpStatus: null });
    assert.deepEqual(managedTeamSyncError(Object.assign(new Error('TEAM_DISABLED'), { endpoint: '/v1/managed/team/sync', httpStatus: 403 })), { code: 'TEAM_DISABLED', endpoint: '/v1/managed/team/sync', httpStatus: 403 });
    console.info('managed-team-sync-status-test: ok');
  } finally {
    if (previous === undefined) delete process.env.DATA;
    else process.env.DATA = previous;
    await rm(folder, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
