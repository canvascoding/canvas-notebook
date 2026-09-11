import 'server-only';

import crypto, { randomUUID } from 'node:crypto';

import {
  applyExactTextEdits,
  countExactTextOccurrences,
  resolveExactTextEditMatchCount,
  type ExactTextEdit,
} from '@/app/lib/files/exact-text-patch';
import { WorkspaceFileRevisionError } from '@/app/lib/files/revision-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import {
  applyAgentTextTargets,
  applyPersistedAgentTextOperation,
  createAgentTextTarget,
  createRichAgentTextTargets,
  createRichMarkdownReviewTarget,
  type AgentTextTarget,
  type AgentFileEditRequestReceipt,
  type PersistedAgentApplyResult,
} from './agent-operations';
import { readCurrentCollaborationDocument } from './document-access';
import { richMarkdownFromYDoc, validateRichMarkdownYDoc } from './markdown-state';
import { loadCollaborationState } from './persistence';
import { Y } from './server-runtime';
import { isRichTextCollaborationRepresentation, type TextCollaborationRepresentation } from './types';
import { readAgentBlockStructure, validateAgentBlockDocument, type AgentBlockStructure } from './agent-block-structure';
import { applyAgentBlockEdit, prepareAgentBlockEdit, previewAgentBlockEdit, type AgentBlockEditRequest } from './agent-block-edits';

export type CollaborationAgentIdentity = {
  initiatedByUserId: string;
  actorId: string;
  actorDisplayName: string;
  actorSessionId?: string;
};

export type CollaborationTextSnapshot = {
  documentId: string;
  path: string;
  representation: TextCollaborationRepresentation;
  lifecycleGeneration: number;
  schemaVersion: number;
  documentSequence: number;
  checkpointSequence: number;
  content: string;
  sha256: string;
  stateVector: string;
  structure?: {
    blocks: Array<AgentBlockStructure & { textTruncated: boolean }>;
    offset: number;
    nextOffset: number | null;
    totalBlocks: number;
  };
};

export type CollaborationAgentDocumentReference = {
  documentId: string;
  lifecycleGeneration: number;
  schemaVersion: number;
};

export type CollaborationStructureReadOptions = {
  includeStructure?: boolean;
  structureOffset?: number;
  structureLimit?: number;
};

export type PreparedCollaborationTextEdit = CollaborationTextSnapshot & {
  proposedContent: string;
  proposedSha256: string;
  targets: AgentTextTarget[];
  requestedMode: 'direct_apply' | 'review';
};

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalContent(
  representation: CollaborationTextSnapshot['representation'],
  doc: InstanceType<typeof Y.Doc>,
): string {
  return representation === 'plain_text'
    ? doc.getText('content').toString()
    : richMarkdownFromYDoc(doc);
}

function createPlainTargets(input: {
  doc: InstanceType<typeof Y.Doc>;
  content: string;
  proposedContent: string;
  edits: ExactTextEdit[];
  groupId: string;
}): AgentTextTarget[] {
  const text = input.doc.getText('content');
  const targets: AgentTextTarget[] = [];
  for (const [editIndex, edit] of input.edits.entries()) {
    const expectedOccurrences = edit.replaceAll
      ? countExactTextOccurrences(input.content, edit.oldText)
      : edit.expectedOccurrences ?? 1;
    if (expectedOccurrences === 0 || countExactTextOccurrences(input.content, edit.oldText) !== expectedOccurrences) {
      return [createAgentTextTarget({
        text,
        from: 0,
        to: text.length,
        replacement: input.proposedContent,
        groupId: input.groupId,
        targetId: `${input.groupId}:document`,
      })];
    }
    let offset = 0;
    for (let occurrence = 0; occurrence < expectedOccurrences; occurrence += 1) {
      const from = input.content.indexOf(edit.oldText, offset);
      targets.push(createAgentTextTarget({
        text,
        from,
        to: from + edit.oldText.length,
        replacement: edit.newText,
        groupId: input.groupId,
        targetId: `${input.groupId}:${editIndex}:${occurrence}`,
      }));
      offset = from + edit.oldText.length;
    }
  }
  return targets;
}

function createRichTargets(input: {
  doc: InstanceType<typeof Y.Doc>;
  edits: ExactTextEdit[];
  groupId: string;
}): AgentTextTarget[] {
  const currentMarkdown = richMarkdownFromYDoc(input.doc);
  return input.edits.flatMap((edit, editIndex) => (
    createRichAgentTextTargets({
      doc: input.doc,
      search: edit.oldText,
      replacement: edit.newText,
      expectedOccurrences: resolveExactTextEditMatchCount({
        content: currentMarkdown,
        edit,
        label: 'live Markdown collaboration state',
        editIndex,
      }),
      groupId: input.groupId,
    }).map((target, occurrence) => ({
      ...target,
      targetId: `${input.groupId}:${editIndex}:${occurrence}`,
    }))
  ));
}

function directTargetsProduceProposedContent(input: {
  doc: InstanceType<typeof Y.Doc>;
  representation: CollaborationTextSnapshot['representation'];
  targets: AgentTextTarget[];
  proposedContent: string;
}): boolean {
  const clone = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(input.doc));
    const preview = applyAgentTextTargets({
      doc: clone,
      targets: input.targets,
      validateClone: isRichTextCollaborationRepresentation(input.representation)
        ? (candidate) => validateRichMarkdownYDoc(candidate).code || null
        : undefined,
      origin: {
        actorType: 'agent',
        actorId: 'preview',
        initiatedByUserId: 'preview',
        operationId: 'preview',
      },
    });
    return preview.status === 'applied_to_ydoc'
      && canonicalContent(input.representation, clone) === input.proposedContent;
  } finally {
    clone.destroy();
  }
}

export async function readCurrentCollaborationTextSnapshot(input: {
  documentId: string;
  workspace: WorkspaceContext;
} & CollaborationStructureReadOptions): Promise<CollaborationTextSnapshot> {
  const state = await loadCollaborationState(input.documentId);
  if (!state || state.status !== 'active' || state.workspaceId !== input.workspace.workspaceId) {
    throw new Error('The collaborative document state is unavailable or stale.');
  }
  return readCurrentCollaborationDocument({
    documentId: state.documentId,
    workspaceId: state.workspaceId,
    read: (doc) => {
      const content = canonicalContent(state.representation, doc);
      let structure: CollaborationTextSnapshot['structure'];
      if (input.includeStructure) {
        if (state.representation !== 'tiptap_blocks') {
          throw new Error('Structured reads require a block collaboration document; this document has not been migrated.');
        }
        const offset = input.structureOffset ?? 0;
        const limit = input.structureLimit ?? 25;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new Error('Structure pagination requires a nonnegative offset and a limit of 1–100 blocks.');
        }
        const blocks = readAgentBlockStructure(doc);
        structure = {
          blocks: blocks.slice(offset, offset + limit).map((block) => ({ ...block,
            text: block.text.slice(0, 2000), textTruncated: block.text.length > 2000 })),
          offset, nextOffset: offset + limit < blocks.length ? offset + limit : null, totalBlocks: blocks.length,
        };
      }
      return {
        documentId: state.documentId,
        path: state.path,
        representation: state.representation,
        lifecycleGeneration: state.lifecycleGeneration,
        schemaVersion: state.schemaVersion,
        documentSequence: state.documentSequence,
        checkpointSequence: state.checkpointSequence,
        content,
        sha256: sha256(content),
        stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
        ...(structure ? { structure } : {}),
      };
    },
  });
}

/** Prepare local block targets against the live document, never the Markdown projection. */
export async function prepareCollaborationBlockEdit(input: {
  document: CollaborationAgentDocumentReference;
  workspace: WorkspaceContext;
  path: string;
  operations?: AgentBlockEditRequest[];
  textEdit?: ExactTextEdit & { blockId: string };
  expectedSha256?: string | null;
  groupId: string;
}): Promise<PreparedCollaborationTextEdit> {
  const state = await loadCollaborationState(input.document.documentId);
  if (!state || state.status !== 'active' || state.workspaceId !== input.workspace.workspaceId
    || state.path !== input.path || state.representation !== 'tiptap_blocks'
    || state.lifecycleGeneration !== input.document.lifecycleGeneration || state.schemaVersion !== input.document.schemaVersion) {
    throw new Error('The structured document reference is stale or unavailable. Read its structure again.');
  }
  if (Boolean(input.operations) === Boolean(input.textEdit)) throw new Error('Supply one structured operation group or one block text edit.');
  return readCurrentCollaborationDocument({ documentId: state.documentId, workspaceId: state.workspaceId, read: (doc) => {
    const content = canonicalContent(state.representation, doc);
    const currentSha256 = sha256(content);
    if (input.expectedSha256 && input.expectedSha256 !== currentSha256) {
      throw new WorkspaceFileRevisionError({ code: 'FILE_REVISION_CONFLICT', status: 409, path: input.path,
        expectedSha256: input.expectedSha256, currentSha256,
        message: 'The live document changed. Read its current structure before retrying.' });
    }
    const clone = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
      const origin = { actorType: 'agent' as const, actorId: 'preview', initiatedByUserId: 'preview', operationId: 'preview' };
      let targets: AgentTextTarget[];
      if (input.textEdit) {
        const edit = input.textEdit;
        const block = readAgentBlockStructure(doc).find((entry) => entry.id === edit.blockId);
        if (!block) throw new Error('The requested block is no longer visible.');
        const expectedOccurrences = resolveExactTextEditMatchCount({ content: block.text, edit, label: 'live block', editIndex: 0 });
        targets = createRichAgentTextTargets({ doc, blockId: edit.blockId, search: edit.oldText,
          replacement: edit.newText, expectedOccurrences, groupId: input.groupId });
        const result = applyAgentTextTargets({ doc: clone, targets, origin,
          validateClone: validateAgentBlockDocument });
        if (result.status !== 'applied_to_ydoc') throw new Error('The block text edit could not be applied safely.');
      } else {
        const blockEdit = prepareAgentBlockEdit(doc, input.operations!);
        const preview = previewAgentBlockEdit(doc, blockEdit);
        targets = [{ kind: 'block_edit', targetId: `${input.groupId}:blocks`, groupId: input.groupId,
          startAnchor: '', endAnchor: '', baseTargetHash: preview.footprintHash,
          replacement: blockEdit.afterText, blockEdit, boundaryPolicy: 'exclude_external' }];
        applyAgentBlockEdit(clone, blockEdit, origin);
      }
      const proposedContent = canonicalContent(state.representation, clone);
      return { documentId: state.documentId, path: state.path, representation: state.representation,
        lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion,
        documentSequence: state.documentSequence, checkpointSequence: state.checkpointSequence,
        content, sha256: currentSha256, stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
        proposedContent, proposedSha256: sha256(proposedContent), targets, requestedMode: 'direct_apply' as const };
    } finally { clone.destroy(); }
  } });
}

export async function prepareCollaborationTextEdit(input: {
  documentId: string;
  workspace: WorkspaceContext;
  path: string;
  edits: ExactTextEdit[];
  expectedSha256?: string | null;
  groupId: string;
}): Promise<PreparedCollaborationTextEdit> {
  if (input.edits.length === 0) throw new Error(`No edits provided for ${input.path}.`);
  const state = await loadCollaborationState(input.documentId);
  if (
    !state
    || state.status !== 'active'
    || state.workspaceId !== input.workspace.workspaceId
    || state.path !== input.path
  ) {
    throw new Error('The collaborative document state is unavailable or stale.');
  }

  return readCurrentCollaborationDocument({
    documentId: state.documentId,
    workspaceId: state.workspaceId,
    read: (doc) => {
      const content = canonicalContent(state.representation, doc);
      const currentSha256 = sha256(content);
      if (input.expectedSha256 && input.expectedSha256 !== currentSha256) {
        throw new WorkspaceFileRevisionError({
          code: 'FILE_REVISION_CONFLICT',
          status: 409,
          path: input.path,
          expectedSha256: input.expectedSha256,
          currentSha256,
          message: `Refusing to edit ${input.path}: expectedSha256 did not match the current live collaboration state (${currentSha256}). Read the file again before retrying.`,
        });
      }
      const proposedContent = applyExactTextEdits(content, input.edits, input.path);
      let targets: AgentTextTarget[] = [];
      let requestedMode: PreparedCollaborationTextEdit['requestedMode'] = 'direct_apply';
      try {
        targets = state.representation === 'plain_text'
          ? createPlainTargets({
              doc,
              content,
              proposedContent,
              edits: input.edits,
              groupId: input.groupId,
            })
          : createRichTargets({ doc, edits: input.edits, groupId: input.groupId });
        if (!directTargetsProduceProposedContent({
          doc,
          representation: state.representation,
          targets,
          proposedContent,
        })) {
          throw new Error('The exact edits require a structural collaboration review.');
        }
      } catch (error) {
        if (!isRichTextCollaborationRepresentation(state.representation)) throw error;
        targets = [createRichMarkdownReviewTarget({
          currentMarkdown: content,
          proposedMarkdown: proposedContent,
          edits: input.edits,
          targetId: `${input.groupId}:structural`,
          groupId: input.groupId,
        })];
        requestedMode = 'review';
      }
      return {
        documentId: state.documentId,
        path: state.path,
        representation: state.representation,
        lifecycleGeneration: state.lifecycleGeneration,
        schemaVersion: state.schemaVersion,
        documentSequence: state.documentSequence,
        checkpointSequence: state.checkpointSequence,
        content,
        sha256: currentSha256,
        stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
        proposedContent,
        proposedSha256: sha256(proposedContent),
        targets,
        requestedMode,
      };
    },
  });
}

export async function executePreparedCollaborationTextEdit(input: {
  prepared: PreparedCollaborationTextEdit;
  workspace: WorkspaceContext;
  identity: CollaborationAgentIdentity;
  idempotencyKey?: string;
  fileEditRequest?: AgentFileEditRequestReceipt;
}): Promise<PersistedAgentApplyResult> {
  return applyPersistedAgentTextOperation({
    documentId: input.prepared.documentId,
    workspace: input.workspace,
    initiatedByUserId: input.identity.initiatedByUserId,
    actorId: input.identity.actorId,
    actorDisplayName: input.identity.actorDisplayName,
    idempotencyKey: input.idempotencyKey || `agent-file-edit:${randomUUID()}`,
    runGeneration: 1,
    targets: input.prepared.targets,
    requestedMode: input.prepared.requestedMode,
    explicitUserRequest: true,
    actorSessionId: input.identity.actorSessionId,
    documentPath: input.prepared.path,
    documentRepresentation: input.prepared.representation,
    documentLifecycleGeneration: input.prepared.lifecycleGeneration,
    documentSchemaVersion: input.prepared.schemaVersion,
    baseStateVector: input.prepared.stateVector,
    baseDocumentSequence: input.prepared.documentSequence,
    fileEditRequest: input.fileEditRequest,
  });
}
