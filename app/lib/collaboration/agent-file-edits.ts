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
  type PersistedAgentApplyResult,
} from './agent-operations';
import { readCurrentCollaborationDocument } from './document-access';
import { richMarkdownFromYDoc, validateRichMarkdownYDoc } from './markdown-state';
import { loadCollaborationState } from './persistence';
import { Y } from './server-runtime';

export type CollaborationAgentIdentity = {
  initiatedByUserId: string;
  actorId: string;
  actorDisplayName: string;
  actorSessionId?: string;
};

export type CollaborationTextSnapshot = {
  documentId: string;
  path: string;
  representation: 'plain_text' | 'tiptap_xml';
  lifecycleGeneration: number;
  schemaVersion: number;
  documentSequence: number;
  checkpointSequence: number;
  content: string;
  sha256: string;
  stateVector: string;
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
      validateClone: input.representation === 'tiptap_xml'
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
}): Promise<CollaborationTextSnapshot> {
  const state = await loadCollaborationState(input.documentId);
  if (!state || state.status !== 'active' || state.workspaceId !== input.workspace.workspaceId) {
    throw new Error('The collaborative document state is unavailable or stale.');
  }
  return readCurrentCollaborationDocument({
    documentId: state.documentId,
    workspaceId: state.workspaceId,
    read: (doc) => {
      const content = canonicalContent(state.representation, doc);
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
      };
    },
  });
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
        if (state.representation !== 'tiptap_xml') throw error;
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
  });
}
