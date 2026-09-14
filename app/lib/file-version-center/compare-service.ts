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
  type FileVersionDiffHunkV1,
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
type DiffOperation = { kind: 'context' | 'addition' | 'deletion'; text: string };
type NumberedDiffOperation = DiffOperation & { oldLineNumber: number | null; newLineNumber: number | null };
type DiffCursor = { offset: number; binding: string };

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedText(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

function lines(value: string): string[] {
  if (value.length === 0) return [];
  const normalized = normalizedText(value);
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
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

function patienceAnchors(
  before: string[], after: string[], beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number,
): Array<[number, number]> {
  const beforeUnique = new Map<string, number>();
  const afterUnique = new Map<string, number>();
  for (let index = beforeStart; index < beforeEnd; index += 1) {
    const value = before[index]!;
    beforeUnique.set(value, beforeUnique.has(value) ? -1 : index);
  }
  for (let index = afterStart; index < afterEnd; index += 1) {
    const value = after[index]!;
    afterUnique.set(value, afterUnique.has(value) ? -1 : index);
  }
  const pairs = [...beforeUnique]
    .filter(([value, index]) => index >= 0 && (afterUnique.get(value) ?? -1) >= 0)
    .map(([, index]) => [index, afterUnique.get(before[index]!)!] as [number, number])
    .sort((left, right) => left[0] - right[0]);
  if (pairs.length < 2) return pairs;

  const tails: number[] = [];
  const previous = new Array<number>(pairs.length).fill(-1);
  for (let index = 0; index < pairs.length; index += 1) {
    const afterIndex = pairs[index]![1];
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (pairs[tails[middle]!]![1] < afterIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const result: Array<[number, number]> = [];
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    result.push(pairs[cursor]!);
    cursor = previous[cursor]!;
  }
  return result.reverse();
}

function diffLines(before: string[], after: string[]): DiffOperation[] {
  const result: DiffOperation[] = [];
  const visit = (beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number): void => {
    while (beforeStart < beforeEnd && afterStart < afterEnd && before[beforeStart] === after[afterStart]) {
      result.push({ kind: 'context', text: before[beforeStart]! });
      beforeStart += 1;
      afterStart += 1;
    }
    let suffix = 0;
    while (beforeStart + suffix < beforeEnd && afterStart + suffix < afterEnd
      && before[beforeEnd - suffix - 1] === after[afterEnd - suffix - 1]) suffix += 1;
    const middleBeforeEnd = beforeEnd - suffix;
    const middleAfterEnd = afterEnd - suffix;
    const anchors = patienceAnchors(before, after, beforeStart, middleBeforeEnd, afterStart, middleAfterEnd);
    if (anchors.length > 0) {
      let nextBefore = beforeStart;
      let nextAfter = afterStart;
      for (const [beforeIndex, afterIndex] of anchors) {
        visit(nextBefore, beforeIndex, nextAfter, afterIndex);
        result.push({ kind: 'context', text: before[beforeIndex]! });
        nextBefore = beforeIndex + 1;
        nextAfter = afterIndex + 1;
      }
      visit(nextBefore, middleBeforeEnd, nextAfter, middleAfterEnd);
    } else {
      for (let index = beforeStart; index < middleBeforeEnd; index += 1) {
        result.push({ kind: 'deletion', text: before[index]! });
      }
      for (let index = afterStart; index < middleAfterEnd; index += 1) {
        result.push({ kind: 'addition', text: after[index]! });
      }
    }
    for (let index = suffix; index > 0; index -= 1) {
      result.push({ kind: 'context', text: before[beforeEnd - index]! });
    }
  };
  visit(0, before.length, 0, after.length);
  return result;
}

function numberOperations(operations: DiffOperation[]): NumberedDiffOperation[] {
  let oldLine = 1;
  let newLine = 1;
  return operations.map((operation) => {
    if (operation.kind === 'context') {
      const numbered = { ...operation, oldLineNumber: oldLine, newLineNumber: newLine };
      oldLine += 1;
      newLine += 1;
      return numbered;
    }
    if (operation.kind === 'deletion') {
      const numbered = { ...operation, oldLineNumber: oldLine, newLineNumber: null };
      oldLine += 1;
      return numbered;
    }
    const numbered = { ...operation, oldLineNumber: null, newLineNumber: newLine };
    newLine += 1;
    return numbered;
  });
}

function hunkStart(operations: NumberedDiffOperation[], start: number, side: 'old' | 'new'): number {
  for (let index = start; index < operations.length; index += 1) {
    const value = side === 'old' ? operations[index]!.oldLineNumber : operations[index]!.newLineNumber;
    if (value !== null) return value;
  }
  for (let index = start - 1; index >= 0; index -= 1) {
    const value = side === 'old' ? operations[index]!.oldLineNumber : operations[index]!.newLineNumber;
    if (value !== null) return value + 1;
  }
  return 1;
}

function createHunks(operations: DiffOperation[]): { hunks: FileVersionDiffHunkV1[]; lineTextTruncated: boolean } {
  const numbered = numberOperations(operations);
  const changed = numbered.flatMap((operation, index) => operation.kind === 'context' ? [] : [index]);
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(numbered.length, index + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  }
  const hunks: FileVersionDiffHunkV1[] = [];
  let lineTextTruncated = false;
  for (const [rangeStart, rangeEnd] of ranges) {
    for (let start = rangeStart; start < rangeEnd; start += FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLinesPerHunk) {
      const end = Math.min(rangeEnd, start + FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLinesPerHunk);
      const slice = numbered.slice(start, end);
      const safeLines = slice.map((operation) => {
        if (operation.text.length > FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLineCharacters) lineTextTruncated = true;
        return { kind: operation.kind, oldLineNumber: operation.oldLineNumber,
          newLineNumber: operation.newLineNumber,
          text: operation.text.slice(0, FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLineCharacters) };
      });
      hunks.push({
        id: `hunk-${hunks.length + 1}`,
        oldStart: hunkStart(numbered, start, 'old'),
        oldLines: slice.filter((operation) => operation.kind !== 'addition').length,
        newStart: hunkStart(numbered, start, 'new'),
        newLines: slice.filter((operation) => operation.kind !== 'deletion').length,
        lines: safeLines,
      });
    }
  }
  return { hunks, lineTextTruncated };
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

    const currentLines = lines(observed.content);
    const candidateLines = candidateContent === null ? [] : lines(candidateContent);
    const admitted = candidateContent !== null && isFileVersionCompareAdmittedV1({
      currentBytes: Buffer.byteLength(observed.content, 'utf8'),
      selectedBytes: Buffer.byteLength(candidateContent, 'utf8'),
      currentLines: currentLines.length,
      selectedLines: candidateLines.length,
    });
    const operations = admitted ? diffLines(currentLines, candidateLines) : [];
    const summary = operations.reduce((value, operation) => ({
      additions: value.additions + (operation.kind === 'addition' ? 1 : 0),
      deletions: value.deletions + (operation.kind === 'deletion' ? 1 : 0),
      unchanged: value.unchanged + (operation.kind === 'context' ? 1 : 0),
    }), { additions: 0, deletions: 0, unchanged: 0 });
    const built = createHunks(operations);
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
