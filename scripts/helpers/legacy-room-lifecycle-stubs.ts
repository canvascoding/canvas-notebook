import assert from 'node:assert/strict';
import * as lifecycleContext from '../../app/lib/collaboration/file-lifecycle-admission-context';

/** Dependencies outside the legacy room-lifecycle fixtures' scope. These tests
 * exercise real rooms/locks but intentionally do not prove SQL admission, auth,
 * recovery or native owner behavior; their dedicated integration suites do. */
export function legacyRoomLifecycleStub(name: string): { value: unknown } | undefined {
  if (name === '@/app/lib/db') return { value: { openDb: async () => ({
    async run(sql: string) {
      assert(['BEGIN', 'COMMIT', "SET LOCAL statement_timeout = '5s'", "SET LOCAL lock_timeout = '4s'"].includes(sql),
        `Unexpected database operation in the legacy room fixture: ${sql}`);
    },
    async all() { assert.fail('SQL admission is outside this fixture; unexpected query.'); },
    async close() {},
  }) } };
  if (name === '@/app/lib/collaboration/room-admission') return { value: {
    async assertCollaborationAdmissionOpen() {},
  } };
  if (name === '@/app/lib/collaboration/file-lifecycle-writer-admission') return { value: {
    async tryLockFileLifecycleCollaborationWriterAdmission() {},
    async tryLockFileLifecycleCollaborationRoomAdmission() {},
  } };
  if (name === '@/app/lib/collaboration/file-lifecycle-admission-context') return { value: lifecycleContext };
  if (name === '@/app/lib/file-version-center/history-service') return { value: {
    fileVersionHistoryService: { async capturePersistedCollaboration() {} },
  } };
  if (name === '@/app/lib/file-version-center/agent-turn-history') return { value: {
    agentTurnHistoryService: { async recoverExpired() {}, async boundary() {} },
  } };
  if (name === '@/app/lib/mobile/collaboration-ticket') return { value: { disposeMobileCollaborationTickets() {} } };
  return undefined;
}
