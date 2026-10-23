import 'server-only';

import type * as YTypes from 'yjs';
import { DocumentEditError, decodeDocumentEditPatchV1, type DocumentEditPatchV1 } from '../documents/edit-contracts';
import { isDocumentVersionTokenV1 } from '../documents/contracts';
import { documentVersionV1, type DocumentVersionIdentityV1 } from '../documents/read-version';
import { applyAgentBlockTargets, applyAgentTextTargets, createAgentTextTarget, createRichAgentTextTargets,
  type AgentTextTarget } from './agent-operations';
import { prepareAgentBlockEdit, previewAgentBlockEdit } from './agent-block-edits';
import { inspectNativeDocument } from './document-snapshot';
import { Y } from './server-runtime';
import type { TextCollaborationRepresentation } from './types';
import { assertCandidate, assertVersion, captureIdentity, fail, nativeBudget, ownCode, validString,
  validateNativeDocumentEditCandidate, withSourceClone } from './native-document-edit-validation';

export { assertNativeDocumentEditPrecondition, validateNativeDocumentEditCandidate } from './native-document-edit-validation';

type NativePatch = ReturnType<typeof decodeDocumentEditPatchV1>;
const MAX_TARGETS = 32;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_REPLACEMENT_BYTES = 256 * 1024;
export type PreparedNativeDocumentEdit = Readonly<{
  identity: Readonly<DocumentVersionIdentityV1>;
  expectedVersion: string;
  targets: AgentTextTarget[];
  /** Private preview data only. Never publish or apply these updates as a grant. */
  nativeBeforeUpdate: Uint8Array;
  nativeAfterUpdate: Uint8Array;
  beforeStateProof: string;
  afterStateProof: string;
  beforeVersion: string;
  afterVersion: string;
  noChange: boolean;
}>;

function plainTargets(doc: YTypes.Doc, edit: Extract<NativePatch, { kind: 'native_text_replace' }>['edits'][number],
  groupId: string): AgentTextTarget[] {
  const text = doc.getText('content'), value = text.toString(), targets: AgentTextTarget[] = [];
  let offset = 0;
  while (targets.length <= edit.expectedOccurrences) {
    const from = value.indexOf(edit.oldText, offset);
    if (from < 0) break;
    targets.push(createAgentTextTarget({ text, from, to: from + edit.oldText.length,
      replacement: edit.newText, groupId }));
    offset = from + edit.oldText.length;
  }
  if (targets.length !== edit.expectedOccurrences) fail('DOCUMENT_EDIT_CONFLICT');
  return targets;
}

function textTargets(doc: YTypes.Doc, representation: TextCollaborationRepresentation,
  patch: Extract<NativePatch, { kind: 'native_text_replace' }>, groupId: string): AgentTextTarget[] {
  if (patch.blockId !== undefined && representation !== 'tiptap_blocks') fail('DOCUMENT_EDIT_UNSUPPORTED');
  const targets: AgentTextTarget[] = []; let matchedTargets = 0;
  for (const [index, edit] of patch.edits.entries()) {
    if (Buffer.byteLength(edit.newText, 'utf8') > MAX_REPLACEMENT_BYTES) fail('DOCUMENT_TOO_LARGE');
    const matches = representation === 'plain_text' ? plainTargets(doc, edit, groupId)
      : createRichAgentTextTargets({ doc, search: edit.oldText, replacement: edit.newText,
        expectedOccurrences: edit.expectedOccurrences, groupId, blockId: patch.blockId });
    matchedTargets += matches.length;
    if (matchedTargets > MAX_TARGETS) fail('DOCUMENT_TOO_LARGE');
    // Equal text intent still validates scope/occurrences, but must not create
    // needless CRDT delete/insert history or claim a changed native version.
    if (edit.oldText !== edit.newText) for (const [ordinal, target] of matches.entries()) {
      targets.push({ ...target, targetId: `${groupId}:text:${index}:${ordinal}` });
    }
  }
  return targets;
}

/** Pure native preparation. Updates/afterVersion describe this PRIVATE preview,
 * not the eventual room application (which has its own Yjs client clocks).
 * Actual apply must recheck expectedVersion synchronously in the real room. */
export function prepareNativeDocumentEditInDocument(input: {
  doc: YTypes.Doc; identity: DocumentVersionIdentityV1; expectedVersion: string;
  patch: DocumentEditPatchV1; groupId: string;
}): PreparedNativeDocumentEdit {
  const identity = captureIdentity(input.identity);
  if (!isDocumentVersionTokenV1(input.expectedVersion) || !validString(input.groupId, 200)) fail('INVALID_REQUEST');
  const patch = decodeDocumentEditPatchV1(input.patch);
  return withSourceClone(input.doc, (clone, nativeBeforeUpdate) => {
    const before = assertVersion(clone, identity, input.expectedVersion);
    const origin = { actorType: 'agent' as const, actorId: 'native-edit-preview',
      initiatedByUserId: 'native-edit-preview', operationId: 'native-edit-preview' };
    let targets: AgentTextTarget[];
    try {
      if (patch.kind === 'native_text_replace') targets = textTargets(clone, identity.representation, patch, input.groupId);
      else {
        if (identity.representation !== 'tiptap_blocks') fail('DOCUMENT_EDIT_UNSUPPORTED');
        const blockEdit = prepareAgentBlockEdit(clone, structuredClone([...patch.operations]));
        const preview = previewAgentBlockEdit(clone, blockEdit);
        targets = [{ kind: 'block_edit', targetId: `${input.groupId}:blocks`, groupId: input.groupId,
          startAnchor: '', endAnchor: '', baseTargetHash: preview.footprintHash,
          replacement: blockEdit.afterText, blockEdit, boundaryPolicy: 'exclude_external' }];
      }
    } catch (error) {
      if (error instanceof DocumentEditError) throw error;
      fail(ownCode(error) === 'limit_exceeded' ? 'DOCUMENT_TOO_LARGE' : 'DOCUMENT_EDIT_CONFLICT');
    }
    if (targets.length > MAX_TARGETS || Buffer.byteLength(JSON.stringify(targets), 'utf8') > MAX_PAYLOAD_BYTES) fail('DOCUMENT_TOO_LARGE');
    try {
      if (targets.length > 0) {
        const apply = targets.some(target => target.kind === 'block_edit') ? applyAgentBlockTargets : applyAgentTextTargets;
        const applied = apply({ doc: clone, targets, origin,
          validateClone: candidate => validateNativeDocumentEditCandidate(candidate, identity.representation) });
        if (applied.status !== 'applied_to_ydoc' || applied.conflicts.length > 0
          || applied.appliedTargetIds.length !== targets.length) {
          fail(applied.conflicts.some(conflict => conflict.code === 'limit_exceeded')
            ? 'DOCUMENT_TOO_LARGE' : 'DOCUMENT_EDIT_CONFLICT');
        }
      }
    } catch (error) {
      if (error instanceof DocumentEditError) throw error;
      fail(ownCode(error) === 'limit_exceeded' ? 'DOCUMENT_TOO_LARGE' : 'DOCUMENT_EDIT_CONFLICT');
    }
    assertCandidate(clone, identity.representation);
    const after = inspectNativeDocument(clone, identity.representation), nativeAfterUpdate = Y.encodeStateAsUpdate(clone);
    if (nativeAfterUpdate.byteLength > nativeBudget.maxStateBytes) fail('DOCUMENT_TOO_LARGE');
    const afterVersion = documentVersionV1(identity, after.version.stateProof);
    return Object.freeze({ identity, expectedVersion: input.expectedVersion, targets,
      nativeBeforeUpdate, nativeAfterUpdate, beforeStateProof: before.stateProof,
      afterStateProof: after.version.stateProof, beforeVersion: before.version, afterVersion,
      noChange: targets.length === 0 || before.stateProof === after.version.stateProof });
  });
}
