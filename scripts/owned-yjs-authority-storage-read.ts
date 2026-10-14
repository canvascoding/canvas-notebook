/** Bounded read-only durable evidence for the owned restart acceptance spec. */
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { requireOwnedYjsQaTarget } from './lib/owned-yjs-authority-qa';
import { ownedYjsStateFromSqlRow } from './lib/owned-yjs-authority-storage-row';

export async function readOwnedYjsDurableEvidence(input: {
  documentId: string; workspaceId: string; path: string; generation: number;
}) {
  await requireOwnedYjsQaTarget();
  assert.match(input.path, /^owned-yjs-restart-[a-f0-9-]+\.md$/u);
  assert(input.documentId && input.workspaceId && Number.isSafeInteger(input.generation) && input.generation >= 1);
  const database = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, query_timeout: 10_000 });
  try {
    await database.connect(); await database.query('BEGIN READ ONLY');
    const row = (await database.query(`SELECT * FROM collaboration_yjs_states
      WHERE document_id=$1 AND workspace_id=$2 AND organization_id=$3 AND path=$4 AND lifecycle_generation=$5 AND status='active'`,
    [input.documentId, input.workspaceId, process.env.CANVAS_ORGANIZATION_ID, input.path, input.generation])).rows[0];
    assert(row && Buffer.isBuffer(row.yjs_state) && Buffer.isBuffer(row.state_vector));
    assert(row.yjs_state.length <= 4 * 1024 * 1024 && row.state_vector.length <= 256 * 1024);
    const state = ownedYjsStateFromSqlRow(row);
    // Import only after the new receipt/physical root/live OID guard succeeds.
    // This inspection decodes durable native content and never serializes Markdown.
    const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const snapshot = authoritativeNativeCollaborationSnapshot(state);
    return { documentId: snapshot.documentId, generation: snapshot.lifecycleGeneration,
      sequence: snapshot.version.documentSequence, stateProof: snapshot.version.stateProof,
      content: snapshot.content, projection: snapshot.projection };
  } finally { await database.end(); }
}

if (process.argv[1]?.endsWith('/owned-yjs-authority-storage-read.ts')) {
  void (async () => {
    assert.equal(process.argv.length, 3); assert(process.argv[2].length <= 8 * 1024);
    const input = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString());
    process.stdout.write(JSON.stringify(await readOwnedYjsDurableEvidence(input)));
  })().catch(() => { console.error('Owned native durable evidence remained unavailable.'); process.exitCode = 1; });
}
