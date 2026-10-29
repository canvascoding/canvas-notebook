import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { PersistedCollaborationState } from '../collaboration/persistence';
import { inspectPersistedNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { assertNativeDocumentSchema } from '../collaboration/native-document-schema';
import { getNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import { measureDocumentPhase } from '../observability/document-operation-metrics';
import { inspectNativeDocumentLinks, nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeDocumentLinkInventory } from './workspace-link-contract-v2';

const MAX_ENTRIES = 10_000, MAX_BYTES = 32 * 1024 * 1024, MAX_ENTRY_BYTES = 2 * 1024 * 1024;
type Entry = { fingerprint: string; inventory: NativeDocumentLinkInventory; bytes: number };
const entries = new Map<string, Entry>();
const freshReads = new AsyncLocalStorage<boolean>();
let retainedBytes = 0, hits = 0, inspections = 0;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Data only. Actual SQL identity, rights, catalogue, binary bounds and the
 * before/after source checks remain the owning collector's responsibility. */
export async function readNativeDocumentLinkProjection(state: PersistedCollaborationState): Promise<NativeDocumentLinkInventory> {
  // Capture once, before any await. No caller getter, mutable buffer, returned
  // object or shared byte storage can later poison a retained projection.
  const captured = structuredClone(state);
  captured.yjsState = Uint8Array.prototype.slice.call(captured.yjsState);
  captured.stateVector = Uint8Array.prototype.slice.call(captured.stateVector);
  const schema = getNativeInspectionSchema(); // Retain the actual grammar-lifetime check even on a hit.
  const { yjsState, stateVector, ...metadata } = captured;
  const fingerprint = nativeLinkJsonProof({ profile: 'document-link-read-v1', parserVersion: 2,
    metadata, stateHash: hash(yjsState), vectorHash: hash(stateVector) });
  const key = nativeLinkJsonProof([captured.workspaceId, captured.organizationId, captured.documentId]);
  const previous = freshReads.getStore() ? undefined : entries.get(key);
  if (previous?.fingerprint === fingerprint) {
    hits++; entries.delete(key); entries.set(key, previous);
    return structuredClone(previous.inventory);
  }
  return measureDocumentPhase('parse', async () => {
    inspections++;
    const inventory = inspectPersistedNativeCollaborationSnapshot(captured, (doc, snapshot) => {
      assertNativeDocumentSchema(doc, captured.representation, schema);
      return inspectNativeDocumentLinks(doc, snapshot);
    });
    if (!freshReads.getStore()) {
      const bytes = Buffer.byteLength(JSON.stringify(inventory), 'utf8');
      if (bytes <= MAX_ENTRY_BYTES) {
        const old = entries.get(key);
        if (old) { retainedBytes -= old.bytes; entries.delete(key); }
        entries.set(key, { fingerprint, inventory: structuredClone(inventory), bytes }); retainedBytes += bytes;
        while (entries.size > MAX_ENTRIES || retainedBytes > MAX_BYTES) {
          const oldest = entries.keys().next().value!;
          retainedBytes -= entries.get(oldest)!.bytes; entries.delete(oldest);
        }
      }
    }
    return inventory;
  });
}

/** Full recomputation for comparison/repair. This bypass never changes rights,
 * source selection, namespace rules, SQL guards or mutation behavior. */
export function withFreshDocumentLinkReadProjection<T>(operation: () => Promise<T>): Promise<T> {
  return freshReads.run(true, operation);
}

/** Data-only recomputation policy shared by extraction and target resolution. */
export function documentLinkReadProjectionRequiresFreshRead(): boolean {
  return freshReads.getStore() === true;
}

/** Bounded diagnostic counts only, no document identity, content or references. */
export function documentLinkReadProjectionStatistics() {
  return Object.freeze({ entries: entries.size, retainedBytes, hits, inspections, maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES });
}
