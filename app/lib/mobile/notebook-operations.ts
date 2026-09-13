import 'server-only';
import { createHash } from 'node:crypto';
import { openDb } from '@/app/lib/db';

export type MobileNotebookOperation = {
  operation_id: string;
  document_id: string;
  workspace_id: string;
  user_id: string;
  lifecycle_generation: number;
  representation: string;
  document_path: string;
  fingerprint: string;
  base_state_proof: string;
  resulting_state_snapshot: Uint8Array;
  yjs_update: Uint8Array | null;
};

export function mobileNotebookOperationIdentity(input: {
  workspaceId: string; documentId: string; userId: string; path: string;
  content: string; expectedSha256: string; baseRevisionId: string; idempotencyKey?: string;
}) {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const fingerprint = hash([input.path, input.content, input.expectedSha256, input.baseRevisionId]);
  return { fingerprint, operationId: `mobile-notebook-${hash([
    input.workspaceId, input.documentId, input.userId, input.idempotencyKey ?? fingerprint,
  ])}` };
}

export async function readMobileNotebookOperation(operationId: string): Promise<MobileNotebookOperation | null> {
  const database = await openDb();
  try {
    return await database.get('SELECT * FROM mobile_notebook_operations WHERE operation_id=$1', [operationId]) as MobileNotebookOperation ?? null;
  } finally { await database.close(); }
}

/** Store the server-prepared delta before applying it to the shared room. */
export async function prepareMobileNotebookOperation(operation: MobileNotebookOperation): Promise<void> {
  const database = await openDb();
  try {
    await database.run(`INSERT INTO mobile_notebook_operations
      (operation_id,document_id,workspace_id,user_id,lifecycle_generation,representation,document_path,
       fingerprint,base_state_proof,resulting_state_snapshot,yjs_update,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
      operation.operation_id, operation.document_id, operation.workspace_id, operation.user_id,
      operation.lifecycle_generation, operation.representation, operation.document_path,
      operation.fingerprint, operation.base_state_proof, Buffer.from(operation.resulting_state_snapshot),
      operation.yjs_update ? Buffer.from(operation.yjs_update) : null, Date.now(),
    ]);
  } finally { await database.close(); }
}

/** Keep the compact deletion-aware receipt once the recoverable delta is durable. */
export async function compactMobileNotebookOperation(operationId: string): Promise<void> {
  const database = await openDb();
  try { await database.run('UPDATE mobile_notebook_operations SET yjs_update=NULL WHERE operation_id=$1', [operationId]); }
  finally { await database.close(); }
}
