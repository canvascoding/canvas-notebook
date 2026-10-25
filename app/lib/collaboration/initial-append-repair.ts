import 'server-only';

import { createHash } from 'node:crypto';
import { normalizeWorkspaceRelativePath } from '../workspaces/path-guard';
import type { HistoricalCollaborationIdentityEvidence } from './recovery-legacy-evidence';
import type { PersistedCollaborationState } from './persistence';
import { serializeCanonicalText } from './persistence';
import { authoritativeCollaborationSnapshot } from './authoritative-snapshot';
import { recoveryHash } from './recovery-plan';
import { Y } from './server-runtime';

export type LegacyInitialAppendIdentity = HistoricalCollaborationIdentityEvidence & {
  laterRevisions: HistoricalCollaborationIdentityEvidence['revision'][];
};
const POLICY = 'legacy-initial-append-v1';
function requireValue(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Initial append recovery rejected: ${reason}.`);
}

/** Pure, bounded proposal. Only a strictly newer, explicitly linked historical
 * file revision may extend a never-advanced plain-text birth. Every original
 * character and Yjs structure remains in the clone; nothing is deleted/merged. */
export function prepareLegacyInitialAppendRepair(state: PersistedCollaborationState, file: Uint8Array,
  identity: LegacyInitialAppendIdentity) {
  requireValue(state.status === 'active' && state.representation === 'plain_text' && !state.degraded && !state.projectionError
    && state.lifecycleGeneration === 1 && state.documentSequence === 0 && state.checkpointSequence === 0,
  'not an original plain-text birth');
  const { document, lineage } = identity;
  requireValue(document.id === state.documentId && document.provider === 'yjs' && document.status === 'active'
    && document.stateVersion === 0 && document.snapshotRevisionId === identity.revision.id
    && lineage && document.lineageId === lineage.id && lineage.status === 'active'
    && lineage.archivedAt === null && lineage.trashEntryId === null, 'identity not verified');
  const sameScope = (record: typeof identity.revision | typeof document | NonNullable<typeof lineage>) =>
    record.workspaceId === state.workspaceId && record.organizationId === state.organizationId
    && record.customerId === document.customerId && record.projectId === document.projectId
    && record.workspaceType === document.workspaceType;
  requireValue(sameScope(document) && sameScope(lineage) && document.path === state.path && lineage.path === state.path,
    'scope mismatch');
  requireValue(identity.laterRevisions.length > 0, 'later revision required');
  const revisions = [...(identity.history ?? []), identity.revision, ...identity.laterRevisions];
  requireValue(revisions.length <= 10_000 && new Set(revisions.map(revision => revision.id)).size === revisions.length,
    'ambiguous history');
  const preceding = new Set<string>(); let timestamp = 0;
  for (const [index, revision] of revisions.entries()) {
    requireValue(typeof revision.id === 'string' && revision.id.length > 0 && !revision.id.includes('\0')
      && sameScope(revision) && revision.lineageId === lineage.id && revision.historyOnly === false
      && revision.revisionNumber === index + 1 && Number.isSafeInteger(revision.createdAt) && revision.createdAt >= timestamp
      && Number.isSafeInteger(revision.sizeBytes) && revision.sizeBytes >= 0 && revision.sizeBytes <= 5 * 1024 * 1024
      && /^[a-f0-9]{64}$/u.test(revision.contentHash)
      && ['user', 'agent', 'automation', 'system'].includes(revision.createdByActorType)
      && normalizeWorkspaceRelativePath(revision.path) === revision.path && revision.path !== '.'
      && (revision.path === state.path || identity.historicalRevisionPaths?.includes(revision.path))
      && (revision.baseRevisionId === null || preceding.has(revision.baseRevisionId)), 'unverified revision chain');
    preceding.add(revision.id); timestamp = revision.createdAt;
  }
  const latest = revisions[revisions.length - 1];
  requireValue(latest.createdAt > state.persistedAt && latest.contentHash === recoveryHash(file)
    && latest.sizeBytes === file.byteLength && file.byteLength <= 5 * 1024 * 1024, 'current file is not the newer revision');
  const bytes = Buffer.from(file), text = bytes.toString('utf8');
  requireValue(Buffer.from(text, 'utf8').equals(bytes) && text.startsWith('\uFEFF') === state.hasBom
    && (text.includes('\r\n') ? 'crlf' : 'lf') === state.newlineStyle, 'encoding mismatch');
  const canonical = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const before = authoritativeCollaborationSnapshot(state).canonicalContent;
  const oldFile = serializeCanonicalText(before, state);
  requireValue(before.length > 0 && recoveryHash(before) === state.canonicalHash && recoveryHash(oldFile) === state.serializedHash
    && canonical.length > before.length && canonical.startsWith(before)
    && Buffer.from(serializeCanonicalText(canonical, state), 'utf8').equals(bytes)
    && bytes.subarray(0, Buffer.byteLength(oldFile)).equals(Buffer.from(oldFile)), 'file does not strictly extend native text');
  const clone = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(clone, state.yjsState);
    let clientId = createHash('sha256').update(state.yjsState).update(latest.contentHash).update(POLICY).digest().readUInt32LE(0);
    while (clone.store.clients.has(clientId)) clientId = (clientId + 1) >>> 0;
    clone.clientID = clientId;
    const content = clone.getText('content'); requireValue(content.toString() === before, 'native text changed');
    content.insert(content.length, canonical.slice(before.length));
    requireValue(content.toString() === canonical, 'append changed existing text');
    const repairedYjsState = Y.encodeStateAsUpdate(clone), stateVector = Y.encodeStateVector(clone);
    return { policy: POLICY, repairedYjsState, stateVector, originalHash: recoveryHash(state.yjsState),
      repairedHash: recoveryHash(repairedYjsState), canonicalHash: recoveryHash(canonical), serializedHash: latest.contentHash,
      appendedUtf16Units: canonical.length - before.length };
  } finally { clone.destroy(); }
}

/** A NEW checkpoint of the original identity, not fabricated historical data. */
export function identityForInitialAppendCheckpoint(identity: LegacyInitialAppendIdentity,
  state: Pick<PersistedCollaborationState, 'documentId' | 'documentSequence' | 'persistedAt'>): HistoricalCollaborationIdentityEvidence {
  requireValue(identity.document.id === state.documentId && state.documentSequence === 1
    && Number.isSafeInteger(state.persistedAt) && state.persistedAt >= identity.document.updatedAt, 'checkpoint identity mismatch');
  const revisions = [...(identity.history ?? []), identity.revision, ...identity.laterRevisions];
  const latest = revisions.at(-1)!;
  return { document: { ...identity.document, stateVersion: 1, snapshotRevisionId: latest.id, updatedAt: state.persistedAt },
    revision: latest, history: revisions.slice(0, -1), lineage: identity.lineage,
    historicalRevisionPaths: identity.historicalRevisionPaths };
}
