import assert from 'node:assert/strict';
import { closeDatabaseConnections } from '../app/lib/db';
import { createFileGuestService } from '../app/lib/file-guests/service';
import { isFileGuestId } from '../app/lib/file-guests/types';
import { assertOwnedFileGuestFixturePath, ownedFileGuestFixtureWorkspace, withOwnedFileGuestFixtureDatabase } from './lib/owned-file-guest-fixture';

let completed = false;
process.once('beforeExit', () => {
  if (!completed) { console.error('Owned guest challenge did not complete.'); process.exitCode = 1; }
});
const watchdog = setTimeout(() => { console.error('Owned guest challenge exceeded its deadline.'); process.exit(1); }, 25_000);
watchdog.ref();

async function main() {
  assert.equal(process.env.COLLABORATION_E2E, '1');
  const input = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8')) as {
    invitationId: string; workspaceId: string; path: string; email: string;
  };
  assert(isFileGuestId(input.invitationId)); assert.match(input.email, /^guest-[a-f0-9-]+@example\.invalid$/u);
  const { receipt } = await ownedFileGuestFixtureWorkspace(input.workspaceId);
  assertOwnedFileGuestFixturePath(input.path, receipt);
  try {
    await withOwnedFileGuestFixtureDatabase(receipt, async database => {
      const row = (await database.query(`SELECT i.id FROM file_guest_invitations i
        JOIN collaboration_documents d ON d.id=i.document_id AND d.lineage_id=i.lineage_id
        JOIN collaboration_yjs_states s ON s.document_id=d.id AND s.lifecycle_generation=i.lifecycle_generation
        WHERE i.id=$1 AND i.workspace_id=$2 AND i.path=$3 AND i.email=$4 AND i.status='active'
          AND i.created_by_user_id=$5 AND d.workspace_id=i.workspace_id AND d.path=i.path AND d.status='active'
          AND s.workspace_id=i.workspace_id AND s.path=i.path AND s.status='active'`,
      [input.invitationId,input.workspaceId,input.path,input.email,receipt.actorId])).rows[0];
      assert(row, 'The exact owned invitation must already exist through the real authenticated UI.');
    });
    let deliveredCode: string | undefined;
    const service = createFileGuestService({ sendCode: async message => {
      assert.equal(message.email, input.email); deliveredCode = message.code;
    } });
    await service.challenge(input.invitationId);
    assert.match(deliveredCode!, /^\d{6}$/u);
    process.stdout.write(`\nCANVAS_GUEST_CHALLENGE_RESULT=${JSON.stringify({ code: deliveredCode })}\n`);
  } finally { await closeDatabaseConnections(); }
}
void main().then(() => { completed = true; clearTimeout(watchdog); }, error => {
  process.exitCode = 1; clearTimeout(watchdog);
  console.error(error instanceof Error ? error.name : 'Owned guest challenge failed.');
});
