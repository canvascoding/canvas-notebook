import 'server-only';

import { createHash } from 'node:crypto';

import { isLiveCollaborationDocumentReaderAvailable } from '@/app/lib/collaboration/document-access';
import { isCollaborationDirectConnectionAvailable } from '@/app/lib/collaboration/direct-connection';
import { resolveTextCollaborationState } from '@/app/lib/collaboration/document-state-service';
import { loadCollaborationStateIncludingArchived } from '@/app/lib/collaboration/persistence';
import { getFileCollaborationState, readFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { getFileStats, readFile, type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { WorkspaceFileOperationPreview } from './workspace-file-operation-planner';
import { applyWorkspacePlainLinkWrite, type WorkspacePlainLinkWriteReceipt } from './workspace-link-file-write';
import {
  applyActiveWorkspaceLinkEdits,
  preflightActiveWorkspaceLinkEdits,
  type ActiveWorkspaceLinkEditsInput,
  type ActiveWorkspaceLinkEditsResult,
} from './workspace-link-yjs-edits';
import { groupWorkspaceLinkWrites, type WorkspaceLinkWriteGroup } from './workspace-link-write-groups';

export type WorkspaceLinkWriteScope = {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
};

export type WorkspaceLinkWriteExecutorInput = {
  /** This preview must be rebuilt by the server under ordered workspace locks. */
  plan: WorkspaceFileOperationPreview;
  source: WorkspaceLinkWriteScope;
  destination: WorkspaceLinkWriteScope;
  actorUserId: string;
  actorId: string;
  actorDisplayName: string;
  actorType?: 'agent' | 'user';
  actorSessionId?: string;
  operationId: string;
};

/** Serializable evidence for the path coordinator's journal; apply can also recover from the plan alone. */
export type WorkspaceLinkWritePreflight = {
  planId: string;
  sources: Array<{
    sourceWorkspaceId: string;
    sourcePathBefore: string;
    beforeSha256: string;
    documentId: string | null;
    mode: 'active-yjs' | 'plain-file';
  }>;
};

export type WorkspaceLinkWriteReceipt = {
  workspaceId: string;
  path: string;
  beforeSha256: string;
  afterSha256: string;
  status: 'applied' | 'already-applied';
  mode: 'active-yjs' | 'plain-file';
  documentId: string | null;
};

export type WorkspaceLinkWriteProbe = 'before' | 'after' | 'unknown';

export class WorkspaceLinkWriteExecutorError extends Error {
  readonly status = 409;

  constructor(
    readonly code: 'LINK_WRITE_INVALID_PLAN' | 'LINK_WRITE_STALE' | 'LINK_WRITE_STALE_DOCUMENT'
      | 'LINK_WRITE_UNSUPPORTED' | 'LINK_WRITE_PARTIAL',
    message: string,
    readonly completed: readonly WorkspaceLinkWriteReceipt[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkspaceLinkWriteExecutorError';
  }
}

type Dependencies = {
  readCollaborationState?: typeof readFileCollaborationState;
  ensureCollaborationState?: typeof getFileCollaborationState;
  loadPersistedState?: typeof loadCollaborationStateIncludingArchived;
  readFile?: typeof readFile;
  getFileStats?: typeof getFileStats;
  isDirectConnectionAvailable?: typeof isCollaborationDirectConnectionAvailable;
  isLiveReaderAvailable?: typeof isLiveCollaborationDocumentReaderAvailable;
  resolveTextState?: typeof resolveTextCollaborationState;
  preflightActive?: typeof preflightActiveWorkspaceLinkEdits;
  applyActive?: typeof applyActiveWorkspaceLinkEdits;
  applyPlain?: typeof applyWorkspacePlainLinkWrite;
};

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sameFileIdentityIgnoringRenameCtime(planned: string, current: string): boolean {
  const plannedParts = planned.split(':');
  const currentParts = current.split(':');
  return plannedParts.length === 5 && currentParts.length === 5
    && plannedParts.every((part) => part !== '' && Number.isFinite(Number(part)))
    && currentParts.every((part) => part !== '' && Number.isFinite(Number(part)))
    && plannedParts.slice(0, 4).every((part, index) => part === currentParts[index]);
}

function originalFileIdentity(input: WorkspaceLinkWriteExecutorInput, group: WorkspaceLinkWriteGroup): string | null {
  const mapping = input.plan.pathMappings.find((entry) =>
    entry.sourceWorkspaceId === group.sourceWorkspaceId && entry.sourcePath === group.sourcePathBefore
    && entry.destinationWorkspaceId === group.workspaceId && entry.destinationPath === group.path);
  if (mapping) return mapping.sourceIdentity;
  return input.plan.expectedPathState.find((entry) =>
    entry.workspaceId === group.sourceWorkspaceId && entry.path === group.sourcePathBefore)?.identity ?? null;
}

function scopesFor(input: WorkspaceLinkWriteExecutorInput): { sourceId: string; destinationId: string } {
  const first = input.plan.pathMappings[0];
  if (!first || !input.plan.planId || input.plan.readiness !== 'ready') {
    throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_INVALID_PLAN', 'Only a ready server plan can be applied.');
  }
  const sourceId = first.sourceWorkspaceId;
  const destinationId = first.destinationWorkspaceId;
  if (input.source.workspace.workspaceId !== sourceId || input.destination.workspace.workspaceId !== destinationId
    || (input.source.fileOptions.workspace && input.source.fileOptions.workspace.workspaceId !== sourceId)
    || (input.destination.fileOptions.workspace && input.destination.fileOptions.workspace.workspaceId !== destinationId)
    || input.plan.pathMappings.some((mapping) =>
      mapping.sourceWorkspaceId !== sourceId || mapping.destinationWorkspaceId !== destinationId)) {
    throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_INVALID_PLAN', 'Workspace scopes do not match the link plan.');
  }
  return { sourceId, destinationId };
}

function validateSourceBytes(group: WorkspaceLinkWriteGroup, bytes: Buffer): void {
  if (sha256(bytes) !== group.beforeSha256) {
    throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE',
      `Markdown source changed before the path operation: ${group.sourcePathBefore}`);
  }
  const content = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(content, 'utf8'))) {
    throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_INVALID_PLAN', 'Markdown source is not lossless UTF-8.');
  }
  let rewritten = content;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of [...group.edits].sort((a, b) => b.targetRange.startUtf16 - a.targetRange.startUtf16)) {
    const { startUtf16, endUtf16, startUtf8Byte, endUtf8Byte } = edit.targetRange;
    if (!Number.isSafeInteger(startUtf16) || !Number.isSafeInteger(endUtf16)
      || startUtf16 < 0 || endUtf16 > content.length || endUtf16 < startUtf16
      || endUtf16 > previousStart
      || typeof edit.previousTargetLiteral !== 'string' || typeof edit.nextTargetLiteral !== 'string'
      || (edit.previousTargetLiteral.length === 0 && edit.nextTargetLiteral.length === 0)
      || startUtf8Byte !== Buffer.byteLength(content.slice(0, startUtf16), 'utf8')
      || endUtf8Byte !== Buffer.byteLength(content.slice(0, endUtf16), 'utf8')
      || content.slice(startUtf16, endUtf16) !== edit.previousTargetLiteral) {
      throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_INVALID_PLAN', 'A source link span does not match the plan.');
    }
    rewritten = `${rewritten.slice(0, startUtf16)}${edit.nextTargetLiteral}${rewritten.slice(endUtf16)}`;
    previousStart = startUtf16;
  }
  if (rewritten !== group.afterContent || sha256(rewritten) !== group.afterSha256) {
    throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_INVALID_PLAN', 'Planned Markdown result does not match link edits.');
  }
}

function activeInput(input: WorkspaceLinkWriteExecutorInput, group: WorkspaceLinkWriteGroup,
  workspace: WorkspaceContext, documentId: string, documentPath: string): ActiveWorkspaceLinkEditsInput {
  return {
    workspace, documentId, documentPath,
    edits: group.edits, afterContent: group.afterContent,
    actorId: input.actorId, actorDisplayName: input.actorDisplayName,
    initiatedByUserId: input.actorUserId, operationId: input.operationId,
    actorType: input.actorType, actorSessionId: input.actorSessionId,
  };
}

function writeReceipt(group: WorkspaceLinkWriteGroup, mode: WorkspaceLinkWriteReceipt['mode'],
  result: WorkspacePlainLinkWriteReceipt | ActiveWorkspaceLinkEditsResult,
  documentId: string | null): WorkspaceLinkWriteReceipt {
  return {
    workspaceId: group.workspaceId, path: group.path,
    beforeSha256: result.beforeSha256, afterSha256: result.afterSha256,
    status: result.status, mode, documentId,
  };
}

/** The caller owns ordered workspace locks, the path mutation, and durable recovery. */
export function createWorkspaceLinkWriteExecutor(dependencies: Dependencies = {}) {
  const readCollaborationState = dependencies.readCollaborationState ?? readFileCollaborationState;
  const ensureCollaborationState = dependencies.ensureCollaborationState ?? getFileCollaborationState;
  const loadPersistedState = dependencies.loadPersistedState ?? loadCollaborationStateIncludingArchived;
  const readBytes = dependencies.readFile ?? readFile;
  const fileStats = dependencies.getFileStats ?? getFileStats;
  const directConnectionAvailable = dependencies.isDirectConnectionAvailable ?? isCollaborationDirectConnectionAvailable;
  const liveReaderAvailable = dependencies.isLiveReaderAvailable ?? isLiveCollaborationDocumentReaderAvailable;
  const resolveTextState = dependencies.resolveTextState ?? resolveTextCollaborationState;
  const preflightActive = dependencies.preflightActive ?? preflightActiveWorkspaceLinkEdits;
  const applyActive = dependencies.applyActive ?? applyActiveWorkspaceLinkEdits;
  const applyPlain = dependencies.applyPlain ?? applyWorkspacePlainLinkWrite;

  const plannedGroup = (input: WorkspaceLinkWriteExecutorInput, group: WorkspaceLinkWriteGroup) => {
    const { destinationId } = scopesFor(input);
    const match = groupWorkspaceLinkWrites(input.plan).find((candidate) =>
      candidate.workspaceId === group.workspaceId && candidate.path === group.path);
    if (group.workspaceId !== destinationId || !match
      || JSON.stringify(match) !== JSON.stringify(group)) {
      throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_INVALID_PLAN', 'Write group differs from the durable plan.');
    }
    return match;
  };

  const priorFor = (input: WorkspaceLinkWriteExecutorInput, group: WorkspaceLinkWriteGroup,
    preflight?: WorkspaceLinkWritePreflight) => {
    if (!preflight) return undefined;
    const groups = groupWorkspaceLinkWrites(input.plan);
    if (preflight.planId !== input.plan.planId || preflight.sources.length !== groups.length) {
      throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_INVALID_PLAN', 'Preflight evidence does not match this plan.');
    }
    const index = groups.findIndex((candidate) =>
      candidate.workspaceId === group.workspaceId && candidate.path === group.path);
    const prior = preflight.sources[index];
    if (!prior || prior.sourceWorkspaceId !== group.sourceWorkspaceId
      || prior.sourcePathBefore !== group.sourcePathBefore || prior.beforeSha256 !== group.beforeSha256
      || (prior.mode === 'active-yjs' && !prior.documentId)
      || (prior.mode === 'plain-file' && prior.documentId !== null)) {
      throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_INVALID_PLAN', 'Preflight source does not match the write group.');
    }
    return prior;
  };

  const targetDocument = async (input: WorkspaceLinkWriteExecutorInput, group: WorkspaceLinkWriteGroup,
    preflight?: WorkspaceLinkWritePreflight): Promise<string | null> => {
    const prior = priorFor(input, group, preflight);
    const metadata = await readCollaborationState({ workspace: input.destination.workspace, path: group.path });
    const documentId = metadata.document?.status === 'active' ? metadata.document.id : null;
    if (metadata.document && !documentId) {
      throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT', 'Destination collaboration document is not active.');
    }
    if (prior?.documentId && input.plan.kind !== 'copy' && prior.documentId !== documentId) {
      throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT', 'Moved collaboration identity changed.');
    }
    if (prior?.documentId && input.plan.kind === 'copy' && prior.documentId === documentId) {
      throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT', 'Copied file retained the source document identity.');
    }
    if (prior?.mode === 'plain-file' && documentId && input.plan.kind !== 'copy') {
      throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
        'An unplanned collaboration document became authoritative after the path operation.');
    }
    // A recovered non-copy Yjs write has no preflight receipt. Only the same
    // filesystem object and exact planned bytes can establish source identity.
    if (documentId && !prior && input.plan.kind !== 'copy') {
      const plannedIdentity = originalFileIdentity(input, group);
      const currentStats = await fileStats(group.path, input.destination.fileOptions);
      const currentBytes = await readBytes(group.path, input.destination.fileOptions);
      if (!plannedIdentity || !currentStats.isFile
        || !sameFileIdentityIgnoringRenameCtime(plannedIdentity, currentStats.fileVersion)
        || ![group.beforeSha256, group.afterSha256].includes(sha256(currentBytes))) {
        throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
          'The recovered Yjs destination cannot be tied to the planned source identity and content.');
      }
    }
    return documentId;
  };

  const applyGroup = async (input: WorkspaceLinkWriteExecutorInput, group: WorkspaceLinkWriteGroup,
    options: { preflight?: WorkspaceLinkWritePreflight } = {}): Promise<WorkspaceLinkWriteReceipt> => {
    const planned = plannedGroup(input, group);
    let documentId = await targetDocument(input, planned, options.preflight);
    if (!documentId && input.plan.kind === 'copy') {
      // Copy creates a new path and lineage, but may not yet have a document.
      // A whole-file write would itself allocate an active Yjs document and
      // then be rejected, so establish the destination identity explicitly.
      const bytes = await readBytes(planned.path, input.destination.fileOptions);
      validateSourceBytes(planned, bytes);
      const ensured = await ensureCollaborationState({
        workspace: input.destination.workspace, path: planned.path, ensureDocument: true,
      });
      if (ensured.document?.status !== 'active' || ensured.document.provider !== 'yjs') {
        throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
          'Copied Markdown destination has no active Yjs document.');
      }
      documentId = await targetDocument(input, planned, options.preflight);
      if (documentId !== ensured.document.id) {
        throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
          'Copied collaboration identity changed during initialization.');
      }
    }
    let receipt: WorkspaceLinkWriteReceipt;
    if (documentId) {
      if (input.plan.kind === 'copy') {
        const currentBytes = await readBytes(planned.path, input.destination.fileOptions);
        const persisted = await loadPersistedState(documentId);
        if (!persisted) {
          validateSourceBytes(planned, currentBytes);
          if (!directConnectionAvailable() || !liveReaderAvailable()) {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
              'The authoritative collaboration bridge is unavailable.');
          }
          const metadata = await readCollaborationState({ workspace: input.destination.workspace, path: planned.path });
          if (metadata.document?.id !== documentId || metadata.document.status !== 'active') {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
              'Copied collaboration identity changed before Yjs initialization.');
          }
          const initialContent = currentBytes.toString('utf8');
          if (initialContent.charCodeAt(0) === 0xfeff || /\r/u.test(initialContent)) {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_UNSUPPORTED',
              'Exact Yjs link edits require Markdown with LF and no BOM.');
          }
          const resolved = await resolveTextState({
            document: metadata.document, workspace: input.destination.workspace,
            path: planned.path, initialRepresentation: 'plain_text', initialContent,
            requireRepresentationMatch: true,
          });
          if (resolved.state.documentId !== documentId
            || resolved.state.workspaceId !== planned.workspaceId || resolved.state.path !== planned.path
            || resolved.state.representation !== 'plain_text' || resolved.state.status !== 'active'
            || resolved.state.degraded) {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
              'Initialized copied collaboration state differs from the planned destination.');
          }
          if (await targetDocument(input, planned, options.preflight) !== documentId) {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
              'Copied collaboration identity changed during Yjs initialization.');
          }
          validateSourceBytes(planned, await readBytes(planned.path, input.destination.fileOptions));
          const checked = await preflightActive(activeInput(input, planned,
            input.destination.workspace, documentId, planned.path));
          if (checked.status !== 'ready' || checked.beforeSha256 !== planned.beforeSha256
            || checked.afterSha256 !== planned.afterSha256) {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE',
              'Initialized copied Yjs state differs from the planned Markdown edit.');
          }
        }
      }
      const result = await applyActive(activeInput(input, planned,
        input.destination.workspace, documentId, planned.path));
      receipt = writeReceipt(planned, 'active-yjs', result, documentId);
    } else {
      if (input.plan.kind !== 'copy') {
        throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
          'Markdown source lost its preflight collaboration identity.');
      }
      const result = await applyPlain({
        workspace: input.destination.workspace, fileOptions: input.destination.fileOptions,
        actorUserId: input.actorUserId, path: planned.path,
        edits: planned.edits, afterContent: planned.afterContent,
      });
      receipt = writeReceipt(planned, 'plain-file', result, null);
    }
    if (receipt.afterSha256 !== planned.afterSha256 || receipt.beforeSha256 !== planned.beforeSha256) {
      throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE', 'Written Markdown hash differs from the plan.');
    }
    return receipt;
  };

  const probeGroup = async (input: WorkspaceLinkWriteExecutorInput,
    group: WorkspaceLinkWriteGroup, options: { preflight?: WorkspaceLinkWritePreflight } = {}): Promise<WorkspaceLinkWriteProbe> => {
    try {
      const planned = plannedGroup(input, group);
      const documentId = await targetDocument(input, planned, options.preflight);
      if (documentId) {
        if (!directConnectionAvailable() || !liveReaderAvailable()) return 'unknown';
        if (input.plan.kind === 'copy' && !(await loadPersistedState(documentId))) {
          validateSourceBytes(planned, await readBytes(planned.path, input.destination.fileOptions));
          return 'before';
        }
        const result = await preflightActive(activeInput(input, planned,
          input.destination.workspace, documentId, planned.path));
        if (result.beforeSha256 !== planned.beforeSha256 || result.afterSha256 !== planned.afterSha256) return 'unknown';
        return result.status === 'ready' ? 'before' : result.status === 'already-applied' ? 'after' : 'unknown';
      }
      const bytes = await readBytes(planned.path, input.destination.fileOptions);
      if (bytes.equals(Buffer.from(planned.afterContent, 'utf8'))) return 'after';
      validateSourceBytes(planned, bytes);
      return 'before';
    } catch {
      return 'unknown';
    }
  };

  return {
    async preflight(input: WorkspaceLinkWriteExecutorInput): Promise<WorkspaceLinkWritePreflight> {
      const { sourceId } = scopesFor(input);
      const groups = groupWorkspaceLinkWrites(input.plan);
      const sources: WorkspaceLinkWritePreflight['sources'] = [];
      for (const group of groups) {
        if (group.sourceWorkspaceId !== sourceId) {
          throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_INVALID_PLAN', 'Link source is outside the source workspace.');
        }
        const bytes = await readBytes(group.sourcePathBefore, input.source.fileOptions);
        validateSourceBytes(group, bytes);
        let metadata = await readCollaborationState({ workspace: input.source.workspace, path: group.sourcePathBefore });
        if (!directConnectionAvailable() || !liveReaderAvailable()) {
          throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
            'The authoritative collaboration reader or writer is unavailable before the path operation.');
        }
        if (!metadata.document && input.plan.kind !== 'copy') {
          const ensured = await ensureCollaborationState({
            workspace: input.source.workspace, path: group.sourcePathBefore, ensureDocument: true,
          });
          if (ensured.document?.status !== 'active' || ensured.document.provider !== 'yjs') {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
              'Markdown source cannot establish an active Yjs document.');
          }
          metadata = await readCollaborationState({
            workspace: input.source.workspace, path: group.sourcePathBefore,
          });
          if (metadata.document?.id !== ensured.document.id) {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
              'Markdown source collaboration identity changed during allocation.');
          }
          validateSourceBytes(group, await readBytes(group.sourcePathBefore, input.source.fileOptions));
        }
        const documentId = metadata.document?.status === 'active' ? metadata.document.id : null;
        if (metadata.document && !documentId) {
          throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT', 'The source collaboration document is not active.');
        }
        if (documentId) {
          if (!directConnectionAvailable() || !liveReaderAvailable()) {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
              'The authoritative collaboration reader or writer is unavailable before the path operation.');
          }
          // A normal file write may allocate the active document identity
          // before anyone opens an editor. Establish its Yjs state from these
          // already validated bytes while the path still exists. Existing
          // rich documents are never converted to plain text here.
          const initialContent = bytes.toString('utf8');
          if (initialContent.charCodeAt(0) === 0xfeff || /\r/u.test(initialContent)) {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_UNSUPPORTED',
              'Exact Yjs link edits require Markdown with LF and no BOM.');
          }
          const resolved = await resolveTextState({
            document: metadata.document!, workspace: input.source.workspace,
            path: group.sourcePathBefore, initialRepresentation: 'plain_text',
            initialContent, requireRepresentationMatch: true,
          });
          if (resolved.state.documentId !== documentId
            || resolved.state.workspaceId !== group.sourceWorkspaceId
            || resolved.state.path !== group.sourcePathBefore
            || resolved.state.representation !== 'plain_text'
            || resolved.state.status !== 'active' || resolved.state.degraded) {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
              'Initialized collaboration state does not match the planned source.');
          }
          const currentMetadata = await readCollaborationState({
            workspace: input.source.workspace, path: group.sourcePathBefore,
          });
          if (currentMetadata.document?.id !== documentId || currentMetadata.document.status !== 'active') {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE_DOCUMENT',
              'The collaboration document identity changed during initialization.');
          }
          validateSourceBytes(group, await readBytes(group.sourcePathBefore, input.source.fileOptions));
          const checked = await preflightActive(activeInput(input, group,
            input.source.workspace, documentId, group.sourcePathBefore));
          if (checked.beforeSha256 !== group.beforeSha256 || checked.afterSha256 !== group.afterSha256
            || checked.status !== 'ready') {
            throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_STALE', 'Live source differs from the planned Markdown edit.');
          }
        }
        sources.push({
          sourceWorkspaceId: group.sourceWorkspaceId, sourcePathBefore: group.sourcePathBefore,
          beforeSha256: group.beforeSha256, documentId, mode: documentId ? 'active-yjs' : 'plain-file',
        });
      }
      return { planId: input.plan.planId, sources };
    },

    applyGroup,
    probeGroup,

    /** Reconstructs writes from the durable plan; an in-memory preflight result is optional. */
    async apply(input: WorkspaceLinkWriteExecutorInput, options: {
      preflight?: WorkspaceLinkWritePreflight;
      onReceipt?: (receipt: WorkspaceLinkWriteReceipt) => Promise<void>;
    } = {}): Promise<WorkspaceLinkWriteReceipt[]> {
      const groups = groupWorkspaceLinkWrites(input.plan);
      if (options.preflight && (options.preflight.planId !== input.plan.planId
        || options.preflight.sources.length !== groups.length)) {
        throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_INVALID_PLAN', 'Preflight evidence does not match this plan.');
      }
      const completed: WorkspaceLinkWriteReceipt[] = [];
      for (const group of groups) {
        try {
          const receipt = await applyGroup(input, group, { preflight: options.preflight });
          completed.push(receipt);
          await options.onReceipt?.(receipt);
        } catch (error) {
          throw new WorkspaceLinkWriteExecutorError('LINK_WRITE_PARTIAL',
            'A planned Markdown write failed; completed writes require recovery.', completed, { cause: error });
        }
      }
      return completed;
    },
  };
}

const runtimeExecutor = createWorkspaceLinkWriteExecutor();

export const preflightWorkspaceLinkWrites = runtimeExecutor.preflight;
export const applyWorkspaceLinkWrites = runtimeExecutor.apply;
export const applyWorkspaceLinkWriteGroup = runtimeExecutor.applyGroup;
export const probeWorkspaceLinkWriteGroup = runtimeExecutor.probeGroup;
