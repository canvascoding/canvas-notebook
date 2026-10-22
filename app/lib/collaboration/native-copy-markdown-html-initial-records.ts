import 'server-only';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import { assertNativeCopyStatusSessionOnConnection } from '../files/workspace-operation-native-copy-status';
import { assertNativeCopySessionOnConnection } from '../files/workspace-operation-native-copy-owner';
import { decodeNativeCopyMarkdownBirthV1, type NativeCopyMarkdownBirthV1 } from './native-copy-markdown-birth-contract';
import { nativeCopyMarkdownHtmlInitialCertificate, type RawHtmlCopyNativeBindingV2 } from '../markdown/workspace-raw-html-copy-binding';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { nativeCopyMarkdownImportIds } from './native-copy-markdown-birth-contract';
import { RawHtmlSourceBindingError } from '../markdown/workspace-raw-html-source-binding';
function fail(): never { throw new RawHtmlSourceBindingError('RAW_HTML_BINDING_CHANGED'); }
/** Immutable original import Snapshot and Birth -> expected journal certificate.
 * The caller proves the original Parent/Birth/receipt cohort. No historical
 * content/state is reconstructed; no current D1/seq0/S2 or room read occurs. */
export async function readNativeCopyMarkdownHtmlInitialRecordsOnConnection(database: SqlConnection,
  inputs: readonly NativeCopyMarkdownBirthV1[], mode:'owner'|'mcp-status'='owner'): Promise<Readonly<{ certificates: readonly RawHtmlCopyNativeBindingV2[] }>> {
  const captured = captureWorkspaceOperationNativePlanData(inputs, fail, 16 * 1024 * 1024);
  if (!Array.isArray(captured) || captured.length > 10000) fail();
  const births = captured.map(decodeNativeCopyMarkdownBirthV1);
  if (!births.length) return { certificates: [] };
  const origin = births[0].origin, ids = births.map(birth => birth.binding.receipt.operationId);
  if (new Set(ids).size !== ids.length || births.some(birth => !equal(birth.origin, origin))) fail();
  if (mode==='owner') await assertNativeCopySessionOnConnection(database,origin);
  else if (mode==='mcp-status') await assertNativeCopyStatusSessionOnConnection(database,origin); else fail();
  const sizes = await database.all(`SELECT operation_id,pg_catalog.octet_length(after_state_snapshot) AS bytes
    FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=ANY($2::text[])
    ORDER BY operation_id COLLATE "C" LIMIT 10001`, [origin.destinationScope.workspaceId, ids]) as Array<{ operation_id: string; bytes: number }>;
  if (sizes.length !== ids.length || new Set(sizes.map(row => row.operation_id)).size !== ids.length
    || sizes.some(row => !ids.includes(row.operation_id) || !Number.isSafeInteger(Number(row.bytes)) || Number(row.bytes) < 1 || Number(row.bytes) > 8388608)
    || sizes.reduce((sum,row) => sum + Number(row.bytes),0) > 64 * 1024 * 1024) fail();
  const rows = await database.all(`SELECT workspace_id,operation_id,version,organization_id,actor_user_id,actor_session_id,request_id,request_fingerprint,
    CASE WHEN pg_catalog.octet_length(private_result::text)<=32768 THEN private_result END AS private_result,created_at,
    live_yjs_state_sha256,live_state_vector_sha256,
    CASE WHEN pg_catalog.octet_length(after_state_snapshot) BETWEEN 1 AND 8388608 THEN after_state_snapshot END AS snapshot
    FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=ANY($2::text[])
    ORDER BY operation_id COLLATE "C" LIMIT 10001`, [origin.destinationScope.workspaceId, ids]) as Array<Record<string, unknown>>;
  if (rows.length !== ids.length || new Set(rows.map(row => row.operation_id)).size !== ids.length) fail();
  const certificates: RawHtmlCopyNativeBindingV2[] = [];
  for (const birth of births) {
    const target = birth.binding.receipt.target, row = rows.find(row => row.operation_id === birth.binding.receipt.operationId),
      original = nativeCopyMarkdownImportIds(birth.parent.operationId,birth.parent.stageDigest,birth.parent.requirementIndex);
    if (!row || row.workspace_id!==origin.destinationScope.workspaceId || row.version !== 1 || row.organization_id !== origin.destinationScope.organizationId
      || row.actor_user_id !== origin.actor.userId || row.actor_session_id !== origin.actor.sessionId
      || row.operation_id!==original.operationId || row.request_id!==original.requestId
      || row.request_fingerprint!==birth.binding.receipt.requestFingerprint || !equal(row.private_result,birth.binding.receipt)
      || Number(row.created_at) !== target.persistedAt || !Buffer.isBuffer(row.snapshot)
      || row.snapshot.length !== Number(sizes.find(size => size.operation_id === row.operation_id)?.bytes)
      || row.live_yjs_state_sha256 !== birth.binding.nativeBinaryHash || row.live_state_vector_sha256 !== birth.binding.nativeVectorHash
      ) fail();
    certificates.push(nativeCopyMarkdownHtmlInitialCertificate(birth,row.snapshot,row.live_yjs_state_sha256,row.live_state_vector_sha256));
  }
  if (mode==='owner') await assertNativeCopySessionOnConnection(database,origin);
  else if (mode==='mcp-status') await assertNativeCopyStatusSessionOnConnection(database,origin); else fail();
  return { certificates };
}
