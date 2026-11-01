import 'server-only';

import type { AuthInfo } from '@modelcontextprotocol/server';
import { openDb } from '@/app/lib/db';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import { observeOptionalMarkdownCreateBirth, directMcpMarkdownCreateAttribution } from '@/app/lib/files/markdown-create-birth';
import type { MarkdownFileImportReceipt } from '@/app/lib/collaboration/markdown-file-import-persistence';
import { documentVersionV1 } from '@/app/lib/documents/read-version';
import { withDirectMcpDocumentCreatePrincipal, withDirectMcpDocumentCreatePrincipalOnConnection } from './document-read-principal';
import { directMcpIngestFingerprint, DirectMcpFileIngestError, readDirectMcpLegacyIngestStatus } from './file-ingest';
import { directMcpFileLinkFields } from './file-links';

export type IngestStatusSelection = {
  workspaceId: string; path: string; idempotencyKey: string;
  tool: 'create_knowledge_source' | 'import_knowledge_file';
  /** Internal recovery only; a public status request does not require the source again. */
  expectedFingerprint?: string;
};

/** A receipt lookup, never a retry of the write or of its projection. Current
 * write authority is checked on the actual transaction before and after IO.
 * A missing receipt is UNKNOWN: a concurrent commit can still be in flight. */
export async function readDirectMcpIngestStatus(authInfo: AuthInfo, selection: IngestStatusSelection) {
  return withDirectMcpDocumentCreatePrincipal(authInfo, selection, () => {}, principal =>
    executeLifecycleTransaction({ openConnection: openDb,
      execute: async database => {
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
        return withDirectMcpDocumentCreatePrincipalOnConnection(database, principal, async access => {
          const operationId = directMcpIngestFingerprint([access.clientId, access.userId, selection.workspaceId, selection.idempotencyKey]);
          const base = { operation_id: operationId, workspace_id: selection.workspaceId, path: selection.path };
          const birth = await observeOptionalMarkdownCreateBirth({ workspaceRoot: access.workspace.rootPath,
            workspaceId: selection.workspaceId, operationId });
          const legacy = await readDirectMcpLegacyIngestStatus({ operationId, path: selection.path,
            workspaceId: selection.workspaceId, expectedFingerprint: selection.expectedFingerprint });
          if (birth && legacy) throw new DirectMcpFileIngestError('MCP_INGEST_RECOVERY_REQUIRED', 'Conflicting original creation records require inspection.');
          if (!birth) {
            return legacy ?? { ...base, storage_status: 'unknown' as const, processing_status: 'unconfirmed' as const };
          }
          const binding = directMcpMarkdownCreateAttribution(birth.intent as Record<string, unknown>);
          if (binding.operationId !== operationId || binding.workspaceId !== selection.workspaceId
            || binding.targetPath !== selection.path || binding.tool !== selection.tool
            || binding.clientId !== access.clientId || binding.actorUserId !== access.userId
            || selection.expectedFingerprint && binding.ingestRequestFingerprint !== selection.expectedFingerprint) {
            throw new DirectMcpFileIngestError('MCP_INGEST_IDEMPOTENCY_CONFLICT', 'This key belongs to a different creation request.');
          }
          const row = await database.get(`SELECT r.private_result, r.actor_user_id, r.request_id,
              b.document_id, b.lifecycle_generation, b.claim_id, b.claim_fingerprint, b.request_fingerprint,
              b.finalized, b.revision_id, b.serialized_hash
            FROM collaboration_markdown_file_import_receipts r
            JOIN collaboration_markdown_create_births b
              ON b.workspace_id=r.workspace_id AND b.operation_id=r.operation_id
            WHERE r.workspace_id=$1 AND r.operation_id=$2`, [selection.workspaceId, operationId]) as
            { private_result: MarkdownFileImportReceipt; actor_user_id: string; request_id: string;
              document_id: string; lifecycle_generation: number; claim_id: string; claim_fingerprint: string; request_fingerprint: string;
              finalized: number; revision_id: string | null; serialized_hash: string | null } | undefined;
          if (!row) return { ...base, storage_status: 'unknown' as const, processing_status: 'unconfirmed' as const };
          const receipt = row.private_result, target = receipt?.target;
          if (!target || receipt.operationId !== operationId || target.workspaceId !== selection.workspaceId
            || target.path !== selection.path || receipt.sourceHash !== binding.sourceHash
            || receipt.sourceBytes !== binding.sourceBytes || row.actor_user_id !== access.userId
            || row.request_id !== binding.requestId || row.document_id !== target.documentId
            || Number(row.lifecycle_generation) !== target.lifecycleGeneration
            || row.claim_id !== birth.id || row.claim_fingerprint !== birth.fingerprint
            || row.request_fingerprint !== receipt.requestFingerprint) {
            throw new DirectMcpFileIngestError('MCP_INGEST_RECOVERY_REQUIRED', 'The original creation receipt could not be verified.');
          }
          // These are original commit facts, not a claim about today's content.
          const version = documentVersionV1({ workspaceId: target.workspaceId, organizationId: target.organizationId,
            documentId: target.documentId, lineageId: target.lineageId, lifecycleGeneration: target.lifecycleGeneration,
            representation: target.representation, schemaVersion: target.schemaVersion }, target.initialStateProof);
          const projected = Number(row.finalized) === 1 && birth.complete
            && birth.revisionId === row.revision_id && birth.serializedHash === row.serialized_hash;
          return { ...base, storage_status: 'confirmed' as const,
            processing_status: projected ? 'completed' as const : 'unconfirmed' as const,
            source_sha256: receipt.sourceHash, source_bytes: receipt.sourceBytes,
            original_version: version, original_durable_sequence: target.initialSequence,
            ...directMcpFileLinkFields({ workspaceId: target.workspaceId, path: target.path,
              documentId: target.documentId, lineageId: target.lineageId }) };
        });
      },
      recoverCommitted: async () => { throw new DirectMcpFileIngestError('MCP_INGEST_STATUS_UNCONFIRMED', 'Retry this read-only status query.'); },
    }));
}
