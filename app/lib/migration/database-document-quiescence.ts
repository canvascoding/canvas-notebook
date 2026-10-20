import 'server-only';

import type { Client } from 'pg';

type Connection = Pick<Client, 'query'>;
const pendingKeys = ['move_pending', 'delete_pending', 'copy_pending', 'copy_birth_pending', 'scene_pending',
  'markdown_birth_pending', 'batch_owner_pending', 'operation_owner_pending', 'agent_pending'] as const;
function blocked(reason: string): never {
  throw Object.assign(new Error(`Portable document snapshot is unconfirmed (${reason}).`), {
    code: 'MIGRATION_DOCUMENT_OPERATIONS_UNCONFIRMED', reason,
  });
}

/** Rejection only, on the exporter's SAME repeatable-read, read-only snapshot.
 * No connection lifecycle, filesystem read, principal, room claim or retry grant.
 * This observes durable incompleteness; it does not quiesce a running service.
 */
export async function assertPortableDocumentOperationsQuiescent(client: Connection): Promise<void> {
  const transaction = (await client.query(`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only`)).rows[0];
  if (transaction?.isolation !== 'repeatable read' || transaction.read_only !== 'on') blocked('snapshot_required');
  const pending = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM public.workspace_file_operation_move_intents i WHERE NOT EXISTS(
      SELECT 1 FROM public.workspace_file_operation_move_receipts r WHERE r.batch_id=i.batch_id AND r.intent_digest=i.intent_digest)) AS move_pending,
    EXISTS(SELECT 1 FROM public.workspace_file_operation_delete_intents i WHERE NOT EXISTS(
      SELECT 1 FROM public.workspace_file_operation_delete_receipts r WHERE r.batch_id=i.batch_id AND r.intent_digest=i.intent_digest)) AS delete_pending,
    EXISTS(SELECT 1 FROM public.collaboration_native_copy_receipts
      WHERE kind IN ('native_clone','native_restore') AND publication_status IS DISTINCT FROM 'published') AS copy_pending,
    EXISTS(SELECT 1 FROM public.collaboration_native_copy_markdown_births b
      LEFT JOIN public.collaboration_native_copy_receipts p ON p.workspace_id=b.workspace_id AND p.operation_id=b.parent_operation_id
      WHERE p.operation_id IS NULL OR p.kind IS DISTINCT FROM 'native_clone'
        OR p.publication_fingerprint IS DISTINCT FROM b.stage_digest
        OR p.publication_status IS DISTINCT FROM 'published') AS copy_birth_pending,
    EXISTS(SELECT 1 FROM public.collaboration_excalidraw_copy_receipts WHERE birth_json IS NULL) AS scene_pending,
    EXISTS(SELECT 1 FROM public.collaboration_markdown_create_births WHERE finalized IS DISTINCT FROM 1) AS markdown_birth_pending,
    EXISTS(SELECT 1 FROM public.workspace_file_operation_batches WHERE status IN ('queued','applying','needs_recovery')) AS batch_owner_pending,
    EXISTS(SELECT 1 FROM public.workspace_file_operations WHERE status IN ('prepared','running','recovery_required')) AS operation_owner_pending,
    EXISTS(SELECT 1 FROM public.collaboration_agent_operations
      WHERE status IN ('preparing','ready','applying','cancel_requested','applied_to_ydoc')
        OR (status='partially_applied' AND error_code='persistence_degraded')) AS agent_pending`)).rows[0];
  if (!pending || pendingKeys.some(key => typeof pending[key] !== 'boolean')) blocked('pending_observation');
  for (const key of pendingKeys) if (pending[key]) blocked(key);

}
