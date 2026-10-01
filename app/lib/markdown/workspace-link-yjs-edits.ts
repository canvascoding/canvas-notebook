import 'server-only';

import { createHash } from 'node:crypto';
import type * as YTypes from 'yjs';

import { readCurrentCollaborationDocument } from '@/app/lib/collaboration/document-access';
import { runCollaborationDirectConnection } from '@/app/lib/collaboration/direct-connection';
import { loadCollaborationState, type PersistedCollaborationState } from '@/app/lib/collaboration/persistence';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { WorkspaceFileLinkEditV1 } from './workspace-link-contract-v1';

export type ActiveWorkspaceLinkEditsInput = {
  workspace: WorkspaceContext;
  documentId: string;
  /** The authoritative path at this phase: before or after the path operation. */
  documentPath: string;
  /** Must come from a server-rebuilt operation plan, never from client-supplied edits. */
  edits: readonly WorkspaceFileLinkEditV1[];
  /** Complete result from that same plan; used to reject mismatched edits and identify safe retries. */
  afterContent: string;
  actorId: string;
  actorDisplayName: string;
  initiatedByUserId: string;
  operationId: string;
  actorType?: 'agent' | 'user';
  actorSessionId?: string;
};

export type ActiveWorkspaceLinkEditsResult = {
  documentId: string;
  documentPath: string;
  lifecycleGeneration: number;
  schemaVersion: number;
  beforeSha256: string;
  afterSha256: string;
  editCount: number;
  status: 'applied' | 'already-applied';
};

export type ActiveWorkspaceLinkPreflightResult = Omit<ActiveWorkspaceLinkEditsResult, 'status'> & {
  status: 'ready' | 'already-applied';
};

export class WorkspaceLinkYjsEditError extends Error {
  readonly status = 409;

  constructor(readonly code:
    'LINK_WRITE_STALE_DOCUMENT' | 'LINK_WRITE_STALE' | 'LINK_WRITE_INVALID_PLAN' | 'LINK_WRITE_UNSUPPORTED',
  message: string) {
    super(message);
    this.name = 'WorkspaceLinkYjsEditError';
  }
}

type State = Pick<PersistedCollaborationState,
  'documentId' | 'workspaceId' | 'path' | 'representation' | 'lifecycleGeneration' | 'schemaVersion'
  | 'newlineStyle' | 'hasBom' | 'degraded' | 'status'>;

type Dependencies = {
  loadState?: (documentId: string) => Promise<State | null>;
  readCurrent?: typeof readCurrentCollaborationDocument;
  directConnection?: typeof runCollaborationDirectConnection;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalid(message: string): never {
  throw new WorkspaceLinkYjsEditError('LINK_WRITE_INVALID_PLAN', message);
}

function validateEditGroup(input: ActiveWorkspaceLinkEditsInput, phase: 'preflight' | 'apply'): WorkspaceFileLinkEditV1[] {
  if (input.edits.length === 0) return invalid('No Markdown link edits were supplied.');
  const sorted = [...input.edits].sort((a, b) => a.targetRange.startUtf16 - b.targetRange.startUtf16);
  const first = sorted[0];
  const originalSource = input.workspace.workspaceId === first.sourceWorkspaceId
    && input.documentPath === first.sourcePathBefore;
  const destination = input.workspace.workspaceId === first.destinationWorkspaceId
    && input.documentPath === first.sourcePathAfter;
  if (phase === 'apply' ? !destination : !originalSource && !destination) {
    return invalid('The collaboration path does not match the planned source path.');
  }
  let previousEnd = -1;
  for (const edit of sorted) {
    if (edit.sourceWorkspaceId !== first.sourceWorkspaceId
      || edit.destinationWorkspaceId !== first.destinationWorkspaceId
      || edit.sourcePathBefore !== first.sourcePathBefore
      || edit.sourcePathAfter !== first.sourcePathAfter
      || edit.expectedContentHash !== first.expectedContentHash) {
      return invalid('Link edits from different source documents cannot be applied together.');
    }
    const range = edit.targetRange;
    if (!Number.isSafeInteger(range.startUtf16) || !Number.isSafeInteger(range.endUtf16)
      || !Number.isSafeInteger(range.startUtf8Byte) || !Number.isSafeInteger(range.endUtf8Byte)
      || range.startUtf16 < 0 || range.endUtf16 < range.startUtf16
      || range.startUtf8Byte < 0 || range.endUtf8Byte < range.startUtf8Byte
      || range.startUtf16 < previousEnd
      || typeof edit.previousTargetLiteral !== 'string' || typeof edit.nextTargetLiteral !== 'string'
      || (edit.previousTargetLiteral.length === 0 && edit.nextTargetLiteral.length === 0)
      || (range.endUtf16 === range.startUtf16) !== (edit.previousTargetLiteral.length === 0)
      || (range.endUtf8Byte === range.startUtf8Byte) !== (edit.previousTargetLiteral.length === 0)) {
      return invalid('The planned link target spans are malformed or overlap.');
    }
    previousEnd = range.endUtf16;
  }
  return sorted;
}

function assertState(state: State | null, input: ActiveWorkspaceLinkEditsInput): asserts state is State {
  if (!state || state.status !== 'active' || state.degraded
    || state.documentId !== input.documentId || state.workspaceId !== input.workspace.workspaceId
    || state.path !== input.documentPath) {
    throw new WorkspaceLinkYjsEditError('LINK_WRITE_STALE_DOCUMENT', 'The active collaboration document identity changed.');
  }
  if (state.representation !== 'plain_text' || state.newlineStyle !== 'lf' || state.hasBom) {
    throw new WorkspaceLinkYjsEditError('LINK_WRITE_UNSUPPORTED',
      'Only plain Y.Text Markdown with LF and no BOM can receive exact link edits.');
  }
}

function isSplitSurrogatePair(content: string, offset: number): boolean {
  return offset > 0 && offset < content.length
    && content.charCodeAt(offset - 1) >= 0xd800 && content.charCodeAt(offset - 1) <= 0xdbff
    && content.charCodeAt(offset) >= 0xdc00 && content.charCodeAt(offset) <= 0xdfff;
}

function validateLiveDocument(
  doc: YTypes.Doc,
  state: State,
  input: ActiveWorkspaceLinkEditsInput,
  edits: readonly WorkspaceFileLinkEditV1[],
): { result: ActiveWorkspaceLinkPreflightResult; text: YTypes.Text; afterContent: string } {
  const shared = doc.share.get('content');
  // Hocuspocus may supply an ESM Y.Doc while the server adapter uses the CJS
  // Yjs constructor. Applying a persisted update also leaves an AbstractType
  // placeholder until getText materializes its actual top-level type. A truly
  // missing or different type must never be created or converted here.
  const sharedType = shared?.constructor.name;
  if (sharedType !== 'YText' && sharedType !== 'AbstractType') {
    throw new WorkspaceLinkYjsEditError('LINK_WRITE_UNSUPPORTED',
      'The live document is not an unformatted Y.Text content value.');
  }
  let text: YTypes.Text;
  try {
    text = doc.getText('content');
  } catch {
    throw new WorkspaceLinkYjsEditError('LINK_WRITE_UNSUPPORTED',
      'The live document is not an unformatted Y.Text content value.');
  }
  const delta = text.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>;
  const validType = text.constructor.name === 'YText'
    && Object.is(text, doc.share.get('content'))
    && (sharedType === 'AbstractType' || Object.is(text, shared));
  const nonString = delta.some((part) => typeof part.insert !== 'string');
  const formatted = delta.some((part) => part.attributes && Object.keys(part.attributes).length > 0);
  if (!validType || nonString || formatted) {
    throw new WorkspaceLinkYjsEditError('LINK_WRITE_UNSUPPORTED',
      'The live document is not an unformatted Y.Text content value.');
  }
  const content = text.toString();
  if (content.charCodeAt(0) === 0xfeff || /\r/u.test(content)) {
    throw new WorkspaceLinkYjsEditError('LINK_WRITE_UNSUPPORTED',
      'The live text cannot be rewritten without changing its byte representation.');
  }
  const beforeSha256 = sha256(content);
  const afterSha256 = sha256(input.afterContent);
  if (content === input.afterContent) {
    return {
      text,
      afterContent: input.afterContent,
      result: {
        documentId: input.documentId, documentPath: input.documentPath,
        lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion,
        beforeSha256: edits[0].expectedContentHash, afterSha256,
        editCount: edits.length, status: 'already-applied',
      },
    };
  }
  if (beforeSha256 !== edits[0].expectedContentHash) {
    throw new WorkspaceLinkYjsEditError('LINK_WRITE_STALE', 'The live document changed since the link plan was built.');
  }
  for (const edit of edits) {
    const range = edit.targetRange;
    if (range.endUtf16 > content.length || isSplitSurrogatePair(content, range.startUtf16)
      || isSplitSurrogatePair(content, range.endUtf16)
      || content.slice(range.startUtf16, range.endUtf16) !== edit.previousTargetLiteral
      || Buffer.byteLength(content.slice(0, range.startUtf16), 'utf8') !== range.startUtf8Byte
      || Buffer.byteLength(content.slice(0, range.endUtf16), 'utf8') !== range.endUtf8Byte) {
      throw new WorkspaceLinkYjsEditError('LINK_WRITE_STALE', 'A planned link target span no longer matches the live document.');
    }
  }
  let afterContent = content;
  for (const edit of [...edits].reverse()) {
    afterContent = `${afterContent.slice(0, edit.targetRange.startUtf16)}${edit.nextTargetLiteral}`
      + afterContent.slice(edit.targetRange.endUtf16);
  }
  if (afterContent !== input.afterContent) {
    return invalid('The planned Markdown result differs from its link edits.');
  }
  return {
    text,
    afterContent,
    result: {
      documentId: input.documentId,
      documentPath: input.documentPath,
      lifecycleGeneration: state.lifecycleGeneration,
      schemaVersion: state.schemaVersion,
      beforeSha256,
      afterSha256,
      editCount: edits.length,
      status: 'ready',
    },
  };
}

/** Read the authoritative room without opening a write connection. Apply still rechecks under the room mutation lock. */
export function createActiveWorkspaceLinkEditService(dependencies: Dependencies = {}) {
  const loadState = dependencies.loadState ?? loadCollaborationState;
  const readCurrent = dependencies.readCurrent ?? readCurrentCollaborationDocument;
  const directConnection = dependencies.directConnection ?? runCollaborationDirectConnection;

  const prepare = async (input: ActiveWorkspaceLinkEditsInput, phase: 'preflight' | 'apply') => {
    const edits = validateEditGroup(input, phase);
    const state = await loadState(input.documentId);
    assertState(state, input);
    return { edits, state };
  };

  return {
    async preflight(input: ActiveWorkspaceLinkEditsInput): Promise<ActiveWorkspaceLinkPreflightResult> {
      const { edits, state } = await prepare(input, 'preflight');
      return readCurrent({
        documentId: state.documentId,
        workspaceId: state.workspaceId,
        read: (doc) => validateLiveDocument(doc, state, input, edits).result,
      });
    },
    async apply(input: ActiveWorkspaceLinkEditsInput): Promise<ActiveWorkspaceLinkEditsResult> {
      const { edits, state } = await prepare(input, 'apply');
      return directConnection({
        documentId: state.documentId,
        documentPath: state.path,
        documentRepresentation: state.representation,
        documentLifecycleGeneration: state.lifecycleGeneration,
        documentSchemaVersion: state.schemaVersion,
        requiresFileCheckpointIdentity: true,
        workspace: input.workspace,
        actorId: input.actorId,
        actorDisplayName: input.actorDisplayName,
        initiatedByUserId: input.initiatedByUserId,
        operationId: input.operationId,
        actorType: input.actorType,
        actorSessionId: input.actorSessionId,
      }, (doc) => {
        const { text, afterContent, result } = validateLiveDocument(doc, state, input, edits);
        if (result.status === 'already-applied') return { ...result, status: 'already-applied' as const };
        doc.transact(() => {
          for (const edit of [...edits].reverse()) {
            text.delete(edit.targetRange.startUtf16, edit.targetRange.endUtf16 - edit.targetRange.startUtf16);
            text.insert(edit.targetRange.startUtf16, edit.nextTargetLiteral);
          }
        }, 'workspace_link_operation');
        if (text.toString() !== afterContent) {
          throw new WorkspaceLinkYjsEditError('LINK_WRITE_STALE', 'The live document changed while link edits were applied.');
        }
        return { ...result, status: 'applied' as const };
      });
    },
  };
}

const runtimeService = createActiveWorkspaceLinkEditService();

export const preflightActiveWorkspaceLinkEdits = runtimeService.preflight;
export const applyActiveWorkspaceLinkEdits = runtimeService.apply;
