import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import type { SqlConnection } from '../app/lib/db';
import { revokeFileGuestPathScope } from '../app/lib/file-guests/lifecycle';

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    await postgres.exec(`
      CREATE TABLE file_guest_invitations (
        id text PRIMARY KEY,
        workspace_id text NOT NULL,
        path text NOT NULL,
        status text NOT NULL,
        policy_revision integer NOT NULL,
        challenge_hash text,
        updated_at bigint NOT NULL
      );
      INSERT INTO file_guest_invitations VALUES
        ('root', 'workspace', 'docs', 'active', 1, 'secret', 1),
        ('child', 'workspace', 'docs/note.md', 'active', 1, 'secret', 1),
        ('other', 'workspace', 'other/note.md', 'active', 1, 'secret', 1);
    `);

    const connection = {
      run: async (sql: string, params?: unknown[]) => postgres.query(sql, params),
    } as SqlConnection;
    const nowMs = Date.parse('2026-09-24T10:11:12.345Z');
    await revokeFileGuestPathScope(connection, { workspaceId: 'workspace', path: 'docs', nowMs });

    const { rows } = await postgres.query<{
      id: string;
      status: string;
      policy_revision: number;
      challenge_hash: string | null;
      updated_at: number;
    }>('SELECT id, status, policy_revision, challenge_hash, updated_at FROM file_guest_invitations ORDER BY id');
    assert.deepEqual(rows, [
      { id: 'child', status: 'revoked', policy_revision: 2, challenge_hash: null, updated_at: nowMs },
      { id: 'other', status: 'active', policy_revision: 1, challenge_hash: 'secret', updated_at: 1 },
      { id: 'root', status: 'revoked', policy_revision: 2, challenge_hash: null, updated_at: nowMs },
    ]);
  } finally {
    await postgres.close();
  }

  console.log('file-guest-lifecycle-timestamp-test: ok');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
