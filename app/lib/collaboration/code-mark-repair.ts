import 'server-only';
import { Y } from './server-runtime';
import { readRichDocumentJson } from './rich-document';
import { validateRichMarkdownYDoc } from './markdown-state';
import { CODE_MARK_CONFLICT_POLICY, normalizeCodeMarkConflicts } from './code-mark-policy';
import { serializeCanonicalText, sha256Text, type PersistedCollaborationState } from './persistence';
import { createHash } from 'node:crypto';

/** A private review artifact, never an in-place repair or lifecycle write. */
export function prepareCodeMarkConflictRepair(state: PersistedCollaborationState) {
  if (state.representation !== 'tiptap_xml' && state.representation !== 'tiptap_blocks') throw new Error('Rich text state required.');
  const originalYjsState = new Uint8Array(state.yjsState);
  const clone = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(clone, originalYjsState);
    if (clone.store.pendingStructs || clone.store.pendingDs
      || !Buffer.from(Y.encodeStateVector(clone)).equals(Buffer.from(state.stateVector))) throw new Error('Incomplete repair evidence.');
    const before = readRichDocumentJson(clone);
    const frontmatter = clone.getText('frontmatter').toString();
    const ending = clone.getText('bodyFinalLineEnding').toString();
    // A reviewed artifact must have identical bytes on a repeated dry-run.
    let repairClientId = createHash('sha256').update(originalYjsState).update(CODE_MARK_CONFLICT_POLICY).digest().readUInt32LE(0);
    while (clone.store.clients.has(repairClientId)) repairClientId = (repairClientId + 1) >>> 0;
    clone.clientID = repairClientId;
    const lostFormatting = normalizeCodeMarkConflicts(clone);
    if (!lostFormatting.length) throw new Error('No Code mark conflict to repair.');
    const expected = JSON.parse(JSON.stringify(before), (key, value) => key === 'marks' && Array.isArray(value)
      && value.some((mark: { type: string }) => mark.type === 'code') ? value.filter((mark: { type: string }) => mark.type === 'code') : value);
    if (JSON.stringify(expected) !== JSON.stringify(readRichDocumentJson(clone))
      || clone.getText('frontmatter').toString() !== frontmatter || clone.getText('bodyFinalLineEnding').toString() !== ending) {
      throw new Error('Repair changed content or structural identities.');
    }
    const validation = validateRichMarkdownYDoc(clone);
    if (!validation.valid || validation.markdown === undefined) throw new Error('Repaired clone does not pass schema and roundtrip validation.');
    const repairedYjsState = Y.encodeStateAsUpdate(clone);
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    return { policy: CODE_MARK_CONFLICT_POLICY, originalYjsState, repairedYjsState,
      originalHash: hash(originalYjsState), repairedHash: hash(repairedYjsState),
      stateVector: Y.encodeStateVector(clone), lostFormatting,
      identity: { documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId,
        path: state.path, lifecycleGeneration: state.lifecycleGeneration, documentSequence: state.documentSequence,
        representation: state.representation, schemaVersion: state.schemaVersion },
      encoding: { hasBom: state.hasBom, newlineStyle: state.newlineStyle },
      serializedHash: sha256Text(serializeCanonicalText(validation.markdown, state)) };
  } finally { clone.destroy(); }
}
