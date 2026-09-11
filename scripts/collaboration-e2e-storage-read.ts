import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeDatabaseConnections, openDb } from '../app/lib/db';
import { loadCollaborationState } from '../app/lib/collaboration/persistence';
import { authoritativeCollaborationSnapshot } from '../app/lib/collaboration/checkpoint';
import { collaborationUpdateStateProof } from '../app/lib/collaboration/state-proof';
import { Y } from '../app/lib/collaboration/server-runtime';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';

async function main() {
  assert.equal(process.env.COLLABORATION_E2E, '1');
  const url = new URL(process.env.DATABASE_URL!);
  assert(['localhost', '127.0.0.1'].includes(url.hostname)); assert.equal(url.port, '55433');
  const input = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8')) as {
    documentId: string; workspaceId: string; path: string; operationId?: string; includeRichJson?: boolean;
  };
  assert.match(input.path, /^(?:collaboration-restart-[a-f0-9-]+\/document|editor-formatting-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.md$/u);
  assert(input.includeRichJson === undefined || typeof input.includeRichJson === 'boolean');
  try {
    const state = await loadCollaborationState(input.documentId);
    assert(state); assert.equal(state.workspaceId, input.workspaceId); assert.equal(state.path, input.path);
    // Optional forensic reads must also prove binary persistence while Markdown projection
    // is correctly rejecting an unrepresentable rich state. Never return that lossy export.
    let rich: { richJson: unknown; validationCode: string | null; canonicalContent: string | null } | undefined;
    if (input.includeRichJson) {
      assert.match(input.path, /^editor-formatting-/u);
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, state.yjsState);
        const validation = validateRichMarkdownYDoc(doc);
        rich = { richJson: readRichDocumentJson(doc), validationCode: validation.valid ? null : validation.code ?? null,
          canonicalContent: validation.valid ? authoritativeCollaborationSnapshot(state).canonicalContent : null };
      } finally { doc.destroy(); }
    }
    const canonicalContent = rich ? rich.canonicalContent : authoritativeCollaborationSnapshot(state).canonicalContent;
    const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
    let receipt: Record<string, unknown> | null = null;
    const database = await openDb();
    try {
      if (input.operationId) {
        const operation = await database.get(`SELECT operation_id, status, result_json, resulting_state_snapshot,
          reverse_payload, applied_at, persisted_at, cas_version FROM collaboration_agent_operations
          WHERE operation_id = $1 AND document_id = $2 AND workspace_id = $3`,
        [input.operationId, input.documentId, input.workspaceId]) as {
          operation_id: string; status: string; result_json: string; resulting_state_snapshot: Uint8Array | null;
          reverse_payload: string | null; applied_at: number; persisted_at: number; cas_version: number;
        } | undefined;
        assert(operation);
        receipt = { operationId: operation.operation_id, status: operation.status,
          resultHash: hash(operation.result_json), snapshotHash: operation.resulting_state_snapshot ? hash(operation.resulting_state_snapshot) : null,
          reverseHash: operation.reverse_payload ? hash(operation.reverse_payload) : null,
          appliedAt: Number(operation.applied_at), persistedAt: Number(operation.persisted_at), casVersion: Number(operation.cas_version) };
      }
      const projection = await database.get(`SELECT lifecycle_generation, projected_sequence, finalized FROM collaboration_file_projections
        WHERE document_id = $1`, [input.documentId]) as { lifecycle_generation: number; projected_sequence: number; finalized: number } | undefined;
      process.stdout.write(JSON.stringify({ documentId: state.documentId, generation: state.lifecycleGeneration,
        documentSequence: state.documentSequence, checkpointSequence: state.checkpointSequence,
        canonicalContent, ...(rich ? { richJson: rich.richJson, validationCode: rich.validationCode } : {}), binaryHash: hash(state.yjsState),
        stateProof: collaborationUpdateStateProof(state.yjsState, Y), degraded: state.degraded,
        projection: projection ? { generation: Number(projection.lifecycle_generation), sequence: Number(projection.projected_sequence), finalized: Number(projection.finalized) } : null,
        receipt }));
    } finally { await database.close(); }
  } finally { await closeDatabaseConnections(); }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : 'Collaboration evidence read failed.'); process.exitCode = 1; });
