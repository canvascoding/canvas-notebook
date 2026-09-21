import 'server-only';

import { createHash } from 'node:crypto';

import { previewAgentOperationContent } from '@/app/lib/collaboration/agent-operations';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  FILE_VERSION_CENTER_CONTRACT_LIMITS,
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  parseFileVersionCompareRequestV1,
  parseFileVersionCompareResponseV1,
  type FileVersionCompareRequestV1,
  type FileVersionCompareResponseV1,
} from './contracts/v1';
import {
  classifyFileVersionFileV1,
  FILE_VERSION_CENTER_LIMITS_V1,
  FILE_VERSION_CENTER_ROLLOUT_ENV_V1,
  isFileVersionCompareAdmittedV1,
  resolveFileVersionRolloutV1,
} from './policy-v1';
import {
  createFileVersionCenterQueryService,
  fileVersionCenterQueryService,
  type FileVersionCenterAccess,
  type ResolvedFileVersionTarget,
} from './query-service';
import { createFileVersionContentStore, type FileVersionContentStore } from './version-content-store';
import {
  fileVersionFencesMatch,
  loadAuthoritativeFileVersionContent,
  type AuthoritativeFileVersionContent,
} from './authoritative-content';
import { fileVersionTextLines, projectFileVersionTextDiff } from './text-diff';
export type { AuthoritativeFileVersionContent } from './authoritative-content';

export type FileVersionAgentCandidate = {
  content: string | null;
  baseSha256: string | null;
  baseStateVectorHash?: string | null;
  proposalVersion?: string | null;
  stale: boolean;
};

export type FileVersionComparePreviewData = {
  format: 'markdown' | 'text';
  current: string;
  candidate: string | null;
  externalRequestsAllowed: false;
  blockedExternalReferences: number;
  blocks: {
    current: number;
    candidate: number;
    unchanged: number;
    changed: number;
  };
};

export type FileVersionCompareResult = {
  response: FileVersionCompareResponseV1;
  preview: FileVersionComparePreviewData;
  actionFence: { proposalVersion: string | null };
};

type CompareQueryService = Pick<ReturnType<typeof createFileVersionCenterQueryService>, 'resolve' | 'resolveOperation'>;
type DiffCursor = { offset: number; binding: string };

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedText(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

async function runtimeAgentCandidate(input: {
  operationId: string;
  workspace: WorkspaceContext;
  userId: string;
}): Promise<FileVersionAgentCandidate> {
  const preview = await previewAgentOperationContent(input);
  return preview
    ? { content: preview.content, baseSha256: preview.baseSha256,
        baseStateVectorHash: preview.baseStateVectorHash,
        proposalVersion: preview.proposalVersion, stale: preview.stale }
    : { content: null, baseSha256: null, stale: true };
}

function encodeCursor(cursor: DiffCursor): string {
  return `v1.${cursor.offset.toString(36)}.${cursor.binding}`;
}

function decodeCursor(value: string | undefined): DiffCursor | null {
  if (!value) return null;
  if (value.length > FILE_VERSION_CENTER_CONTRACT_LIMITS.cursorCharacters
    || !/^v1\.[0-9a-z]+\.[a-f0-9]{32}$/u.test(value)) {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest, 'The comparison cursor is invalid.');
  }
  const [, offsetValue, binding] = value.split('.');
  const offset = Number.parseInt(offsetValue!, 36);
  if (!Number.isSafeInteger(offset) || offset < 0 || !binding) {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest, 'The comparison cursor is invalid.');
  }
  return { offset, binding };
}

function markdownPreview(value: string): { content: string; blocked: number } {
  let blocked = 0;
  let content = normalizedText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  content = content.replace(/^\s*\[[^\]\n]+\]:\s*\S+.*$/gmu, (match) => {
    blocked += 1;
    return `${match.slice(0, match.indexOf(']:') + 2)} (external resource blocked)`;
  });
  content = content.replace(/!\[([^\]\n]*)\]\([^\)\n]*\)/gu, (_match, label: string) => {
    blocked += 1;
    return `[Image: ${label.trim() || 'unlabelled'}; external resource blocked]`;
  });
  content = content.replace(/\[([^\]\n]+)\]\([^\)\n]*\)/gu, (_match, label: string) => {
    blocked += 1;
    return `${label} (external link blocked)`;
  });
  content = content.replace(/<[^>\n]+>/gu, (match) => {
    blocked += 1;
    return match.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  });
  content = content.replace(/\b(?:https?|ftp|file|data|javascript):/giu, (scheme) => {
    blocked += 1;
    return `${scheme.slice(0, -1)}&#58;`;
  });
  return { content, blocked };
}

function textPreview(value: string): string {
  return normalizedText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

function blockStats(current: string, candidate: string): FileVersionComparePreviewData['blocks'] {
  const toBlocks = (value: string) => normalizedText(value).split(/\n\s*\n/gu).map((block) => block.trim()).filter(Boolean);
  const currentBlocks = toBlocks(current);
  const candidateBlocks = toBlocks(candidate);
  const counts = new Map<string, number>();
  currentBlocks.forEach((block) => counts.set(block, (counts.get(block) ?? 0) + 1));
  let unchanged = 0;
  for (const block of candidateBlocks) {
    const count = counts.get(block) ?? 0;
    if (count > 0) {
      unchanged += 1;
      counts.set(block, count - 1);
    }
  }
  return { current: currentBlocks.length, candidate: candidateBlocks.length, unchanged,
    changed: currentBlocks.length + candidateBlocks.length - (2 * unchanged) };
}

export function createFileVersionCompareService(options: {
  query?: CompareQueryService;
  contentStore?: Pick<FileVersionContentStore, 'readRevisionContent'>;
  current?: (target: ResolvedFileVersionTarget, workspace: WorkspaceContext) => Promise<AuthoritativeFileVersionContent>;
  agentCandidate?: (input: { operationId: string; workspace: WorkspaceContext; userId: string }) => Promise<FileVersionAgentCandidate>;
  compareEnabled?: () => boolean;
} = {}) {
  const query = options.query ?? fileVersionCenterQueryService;
  const contentStore = options.contentStore ?? createFileVersionContentStore();
  const current = options.current ?? loadAuthoritativeFileVersionContent;
  const agentCandidate = options.agentCandidate ?? runtimeAgentCandidate;
  const compareEnabled = options.compareEnabled ?? (() => resolveFileVersionRolloutV1(
    process.env[FILE_VERSION_CENTER_ROLLOUT_ENV_V1.mode],
  ).compare);

  const execute = async (input: {
    request: FileVersionCompareRequestV1;
    access: FileVersionCenterAccess;
    workspace: WorkspaceContext;
  }): Promise<FileVersionCompareResult> => {
    const request = parseFileVersionCompareRequestV1(input.request);
    const target = await query.resolve({ target: request.target, access: input.access });
    if (target.workspaceId !== input.workspace.workspaceId) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
        'File version target is not available in the active workspace.');
    }
    const fileClass = classifyFileVersionFileV1(target.path);
    if (!compareEnabled() || (fileClass !== 'markdown' && fileClass !== 'text')) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.capabilityUnavailable,
        'Comparison is not available for this document.');
    }
    const observed = await current(target, input.workspace);
    if (!fileVersionFencesMatch(observed.fence, request.expectedCurrent)) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
        'The current document changed. Reload its timeline before comparing.');
    }

    let candidateContent: string | null = null;
    let candidateStale = false;
    let proposalVersion: string | null = null;
    if (request.candidate.kind === 'revision') {
      const revision = await contentStore.readRevisionContent({ revisionId: request.candidate.id,
        workspaceId: target.workspaceId, lineageId: target.lineageId });
      candidateContent = revision?.content.toString('utf8') ?? null;
    } else {
      const operationTarget = await query.resolveOperation({ operationId: request.candidate.id,
        workspaceId: target.workspaceId, access: input.access });
      if (operationTarget.lineageId !== target.lineageId || operationTarget.documentId !== target.documentId) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.staleSelection,
          'The selected agent proposal belongs to a different document lifecycle.');
      }
      const candidate = await agentCandidate({ operationId: request.candidate.id,
        workspace: input.workspace, userId: input.access.userId });
      candidateContent = candidate.content;
      proposalVersion = candidate.proposalVersion ?? null;
      candidateStale = candidate.stale || candidate.baseSha256 !== observed.fence.sha256
        || (observed.fence.stateVectorHash !== undefined
          && candidate.baseStateVectorHash !== observed.fence.stateVectorHash);
      if (candidateStale) candidateContent = null;
    }

    const contentAvailable = candidateContent !== null;
    const candidateSha256 = candidateContent === null ? sha256(`unavailable:${request.candidate.kind}:${request.candidate.id}`)
      : sha256(candidateContent);
    const cursorBinding = sha256(`${observed.fence.sha256}:${candidateSha256}`).slice(0, 32);
    const cursor = decodeCursor(request.cursor);
    if (cursor && cursor.binding !== cursorBinding) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.staleSelection,
        'The selected comparison content changed. Start the comparison again.');
    }
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FILE_VERSION_CENTER_CONTRACT_LIMITS.diffHunksPerPage) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest,
        'The comparison page size is invalid.');
    }

    const currentBytes = Buffer.byteLength(observed.content, 'utf8');
    const candidateBytes = candidateContent === null ? 0 : Buffer.byteLength(candidateContent, 'utf8');
    const currentByteAdmitted = currentBytes <= FILE_VERSION_CENTER_LIMITS_V1.maxCompareBytesPerSide;
    const bytesAdmitted = candidateContent !== null
      && currentByteAdmitted
      && candidateBytes <= FILE_VERSION_CENTER_LIMITS_V1.maxCompareBytesPerSide
      && currentBytes + candidateBytes <= FILE_VERSION_CENTER_LIMITS_V1.maxCompareCombinedBytes;
    const currentLines = currentByteAdmitted ? fileVersionTextLines(observed.content) : [];
    const candidateLines = bytesAdmitted && candidateContent !== null ? fileVersionTextLines(candidateContent) : [];
    const admitted = bytesAdmitted && isFileVersionCompareAdmittedV1({
      currentBytes,
      selectedBytes: candidateBytes,
      currentLines: currentLines.length,
      selectedLines: candidateLines.length,
    });
    const built = admitted ? projectFileVersionTextDiff(currentLines, candidateLines)
      : { summary: { additions: 0, deletions: 0, unchanged: 0 }, hunks: [], lineTextTruncated: false };
    const { summary } = built;
    const boundedHunks = built.hunks.slice(0, FILE_VERSION_CENTER_LIMITS_V1.maxDiffHunks);
    const offset = cursor?.offset ?? 0;
    if (offset > boundedHunks.length) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest,
        'The comparison cursor is outside the available hunks.');
    }
    const pageHunks = boundedHunks.slice(offset, offset + limit);
    const nextOffset = offset + pageHunks.length;
    const hasMore = nextOffset < boundedHunks.length;
    const response = parseFileVersionCompareResponseV1({
      contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
      current: { fence: observed.fence, observedAt: new Date(observed.observedAt).toISOString() },
      candidate: { selection: request.candidate, stale: candidateStale, contentAvailable },
      summary,
      hunks: pageHunks,
      page: { hasMore, nextCursor: hasMore ? encodeCursor({ offset: nextOffset, binding: cursorBinding }) : null },
      truncated: !admitted || built.lineTextTruncated || built.hunks.length > boundedHunks.length,
    });

    const currentPreviewAdmitted = currentByteAdmitted
      && currentLines.length <= FILE_VERSION_CENTER_LIMITS_V1.maxCompareLinesPerSide;
    const previewAdmitted = candidateContent === null ? currentPreviewAdmitted : admitted;
    if (!previewAdmitted) {
      return { response, actionFence: { proposalVersion }, preview: {
        format: fileClass === 'markdown' ? 'markdown' : 'text',
        current: '',
        candidate: null,
        externalRequestsAllowed: false,
        blockedExternalReferences: 0,
        blocks: { current: 0, candidate: 0, unchanged: 0, changed: 0 },
      } };
    }

    const candidateForPreview = candidateContent ?? '';
    if (fileClass === 'markdown') {
      const safeCurrent = markdownPreview(observed.content);
      const safeCandidate = candidateContent === null ? null : markdownPreview(candidateContent);
      return { response, actionFence: { proposalVersion }, preview: { format: 'markdown', current: safeCurrent.content,
        candidate: safeCandidate?.content ?? null, externalRequestsAllowed: false,
        blockedExternalReferences: safeCurrent.blocked + (safeCandidate?.blocked ?? 0),
        blocks: blockStats(observed.content, candidateForPreview) } };
    }
    return { response, actionFence: { proposalVersion }, preview: { format: 'text', current: textPreview(observed.content),
      candidate: candidateContent === null ? null : textPreview(candidateContent), externalRequestsAllowed: false,
      blockedExternalReferences: 0, blocks: blockStats(observed.content, candidateForPreview) } };
  };

  return {
    compareWithPreview: execute,
    async compare(input: {
      request: FileVersionCompareRequestV1;
      access: FileVersionCenterAccess;
      workspace: WorkspaceContext;
    }): Promise<FileVersionCompareResponseV1> {
      return (await execute(input)).response;
    },
  };
}

export const fileVersionCompareService = createFileVersionCompareService();
