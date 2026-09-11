import assert from 'node:assert/strict';
import { closeDatabaseConnections, openDb } from '../app/lib/db';
import { createFileGuestService } from '../app/lib/file-guests/service';

/** Real invitation/challenge/entitlement checks with only email delivery captured locally. */
async function main() {
  assert.equal(process.env.COLLABORATION_E2E, '1');
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  assert(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname));
  assert.equal(databaseUrl.port, '55433');
  const input = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8')) as {
    invitationId: string; workspaceId: string; path: string; email: string;
  };
  assert.match(input.path, /^guest-collab-[a-f0-9-]+\.md$/u);
  assert.match(input.email, /^guest-[a-f0-9-]+@example\.invalid$/u);
  try {
    const database = await openDb();
    try {
      const invitation = await database.get(`SELECT id FROM file_guest_invitations
        WHERE id = $1 AND workspace_id = $2 AND path = $3 AND email = $4 AND status = 'active'`,
      [input.invitationId, input.workspaceId, input.path, input.email]);
      assert(invitation, 'The guest invitation must already exist through the normal authenticated API.');
    } finally { await database.close(); }
    let deliveredCode: string | undefined;
    const service = createFileGuestService({ sendCode: async (message) => {
      assert.equal(message.email, input.email);
      deliveredCode = message.code;
    } });
    await service.challenge(input.invitationId);
    assert.match(deliveredCode!, /^\d{6}$/u);
    // The browser runner captures stdout privately. Never print the code to the test log.
    process.stdout.write(`\nCANVAS_GUEST_CHALLENGE_RESULT=${JSON.stringify({ code: deliveredCode })}\n`);
  } finally { await closeDatabaseConnections(); }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'The fixture challenge failed.');
  process.exitCode = 1;
});
