import 'server-only';

import { createHash } from 'node:crypto';
import { inspectPersistedNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import type { NativeRecoveryRecord } from '../collaboration/native-document-recovery';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { Y } from '../collaboration/server-runtime';
import type { NativeLinkMutationReceipt } from '../markdown/native-link-mutation-persistence';
import { inspectPersistedDocumentLinksV4, nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { inspectWorkspaceMarkdownHtmlV4 } from '../markdown/workspace-local-link-parser';
import { inspectWorkspaceStaticHtmlLinks } from '../markdown/workspace-html-link-safety';
import { nativeCopyLinkReceiptProof } from './workspace-operation-native-copy-link-receipt-proof';

export type NativeCopyHtmlLinkResultEvidenceV4 = Readonly<{
  resultEvidenceVersion: 4; parserVersion: 4; htmlSourceProof: string;
  /** Hash of the immutable encoded Y.Snapshot, never a full Yjs update. */
  afterBinaryHash: string; afterVectorHash: string;
}>;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
class HtmlCopyReceiptError extends Error {
  readonly code = 'NATIVE_COPY_PHASE_CHANGED'; readonly status = 409;
  constructor() { super('NATIVE_COPY_PHASE_CHANGED'); }
}
function fail(): never { throw new HtmlCopyReceiptError(); }
function htmlProof(state: PersistedCollaborationState): string {
  const inventory = inspectPersistedDocumentLinksV4(state);
  for (const gap of inventory.coverage.gaps) if (gap.code !== 'uninspected-html'
    || typeof gap.raw !== 'string' || !inspectWorkspaceStaticHtmlLinks(gap.raw).fullyInspected) fail();
  const occurrences = inspectPersistedNativeCollaborationSnapshot(state, (_doc, snapshot) => snapshot.content.kind === 'plain_text'
    ? inspectWorkspaceMarkdownHtmlV4(snapshot.content.text, state.path).occurrences : []);
  if (occurrences.some(occurrence => !occurrence.fullyInspected)) fail();
  return proof({ parserVersion: 4, occurrences: occurrences.map(occurrence => ({ raw: occurrence.raw,
    fullyInspected: occurrence.fullyInspected, explicitLocalTargets: occurrence.explicitLocalTargets })) });
}
/** Wrapper around the actual immutable contract-2 SQL receipt. It does not
 * relabel that receipt or mint a mutation capability. The fixed owner has to
 * bind source/clone identities, actors, original Stage and native sequence. */
export function nativeCopyHtmlLinkResultEvidenceV4(original: NativeRecoveryRecord,
  receipt: NativeLinkMutationReceipt): Readonly<{ evidence: NativeCopyHtmlLinkResultEvidenceV4; receiptProof: string }> {
  if (receipt.contractVersion !== 2 || receipt.source.representation !== original.state.representation
    || receipt.source.schemaVersion !== original.state.schemaVersion || receipt.after.documentSequence !== 1
    || receipt.before.documentSequence !== 0 || !(receipt.afterStateSnapshot instanceof Uint8Array)
    || !receipt.afterStateSnapshot.byteLength || receipt.afterStateSnapshot.byteLength > 4 * 1024 * 1024) fail();
  const vector = Buffer.from(receipt.after.stateVector, 'base64'), snapshotHash = sha(receipt.afterStateSnapshot);
  if (!vector.byteLength || vector.toString('base64') !== receipt.after.stateVector || vector.byteLength > 1024 * 1024
    || !Number.isSafeInteger(receipt.after.persistedAt) || receipt.after.persistedAt < 0
    || receipt.after.stateProof !== `yjs-snapshot-sha256-v1:${snapshotHash}`) fail();
  try {
    // SQL retains a content-free Snapshot (state vector plus delete set).
    // Decoding it as an update corrupts the read; today's document is not a
    // historical substitute after later edits. Native4 verified HTML at apply.
    const snapshot = Y.decodeSnapshot(receipt.afterStateSnapshot), encoded = Y.encodeSnapshot(snapshot);
    if (snapshot.sv.size === 0 && snapshot.ds.clients.size === 0
      || !Buffer.from(encoded).equals(Buffer.from(receipt.afterStateSnapshot))
      || !Buffer.from(Y.encodeStateVector(snapshot.sv)).equals(vector)) fail();
  } catch { fail(); }
  const htmlSourceProof = htmlProof(original.state);
  const evidence = Object.freeze({ resultEvidenceVersion: 4 as const, parserVersion: 4 as const, htmlSourceProof,
    afterBinaryHash: snapshotHash, afterVectorHash: sha(vector) });
  return Object.freeze({ evidence, receiptProof: proof({ ...evidence, nativeReceiptProof: nativeCopyLinkReceiptProof(receipt) }) });
}
