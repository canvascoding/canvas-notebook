'use client';

import { fetchReviewComparison, type FileVersionCompareQueryOptions } from '@/app/lib/queries/review-queries';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

import { FileVersionCenterClientError } from './client';
import {
  FILE_VERSION_CENTER_API_V1,
  FILE_VERSION_CENTER_ERROR_CODES,
  parseFileVersionCenterErrorResponseV1,
  parseFileVersionCompareResponseV1,
  type FileVersionCompareRequestV1,
  type FileVersionCompareResponseV1,
} from './contracts/v1';

export type FileVersionComparePreview = {
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

export type FileVersionComparePayload = {
  response: FileVersionCompareResponseV1;
  preview: FileVersionComparePreview;
  actionFence: { proposalVersion: string | null };
};

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parsePreview(value: unknown): FileVersionComparePreview {
  if (!value || typeof value !== 'object') throw new Error('Missing preview.');
  const preview = value as Partial<FileVersionComparePreview>;
  const blocks = preview.blocks as Partial<FileVersionComparePreview['blocks']> | undefined;
  if ((preview.format !== 'markdown' && preview.format !== 'text')
    || typeof preview.current !== 'string'
    || (typeof preview.candidate !== 'string' && preview.candidate !== null)
    || preview.externalRequestsAllowed !== false
    || !safeCount(preview.blockedExternalReferences)
    || !blocks
    || !safeCount(blocks.current)
    || !safeCount(blocks.candidate)
    || !safeCount(blocks.unchanged)
    || !safeCount(blocks.changed)) {
    throw new Error('Invalid preview.');
  }
  return preview as FileVersionComparePreview;
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new FileVersionCenterClientError(
      'FVRC_TRANSPORT_ERROR',
      'The comparison returned an unreadable response.',
      response.status,
      response.status >= 500,
    );
  }
}

async function requestFileVersionComparison(
  request: FileVersionCompareRequestV1,
  signal?: AbortSignal,
): Promise<FileVersionComparePayload> {
  let response: Response;
  try {
    response = await fetch(FILE_VERSION_CENTER_API_V1.compare, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        [WORKSPACE_ID_HEADER]: request.target.workspaceId,
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new FileVersionCenterClientError(
      'FVRC_TRANSPORT_ERROR',
      'The comparison could not be reached.',
      0,
      true,
    );
  }
  const payload = await readPayload(response);
  if (!response.ok) {
    try {
      const failure = parseFileVersionCenterErrorResponseV1(payload);
      throw new FileVersionCenterClientError(
        failure.error.code,
        failure.error.message,
        response.status,
        failure.error.retryable,
      );
    } catch (error) {
      if (error instanceof FileVersionCenterClientError) throw error;
      throw new FileVersionCenterClientError(
        'FVRC_TRANSPORT_ERROR',
        'The comparison request failed.',
        response.status,
        response.status >= 500,
      );
    }
  }
  try {
    const result = payload as { response?: unknown; preview?: unknown };
    const actionFence = (payload as { actionFence?: { proposalVersion?: unknown } }).actionFence;
    if (!actionFence || !Object.hasOwn(actionFence, 'proposalVersion')) {
      throw new Error('Missing action fence.');
    }
    const proposalVersion = actionFence.proposalVersion;
    if (proposalVersion !== null
      && (typeof proposalVersion !== 'string' || !/^v1\.[a-f0-9]{64}$/u.test(proposalVersion))) {
      throw new Error('Invalid action fence.');
    }
    return {
      response: parseFileVersionCompareResponseV1(result.response),
      preview: parsePreview(result.preview),
      actionFence: { proposalVersion },
    };
  } catch {
    throw new FileVersionCenterClientError(
      'FVRC_TRANSPORT_ERROR',
      'The comparison response does not match the expected contract.',
      response.status,
      false,
    );
  }
}

export async function compareFileVersion(
  request: FileVersionCompareRequestV1,
  signal?: AbortSignal,
  options: FileVersionCompareQueryOptions = {},
): Promise<FileVersionComparePayload> {
  return fetchReviewComparison({
    request, signal, options,
    queryFn: async ({ signal: querySignal }) => {
      const result = await requestFileVersionComparison(request, querySignal);
      const fence = result.response.current.fence;
      if (fence.revisionId !== request.expectedCurrent.revisionId
        || fence.sha256 !== request.expectedCurrent.sha256
        || fence.stateVectorHash !== request.expectedCurrent.stateVectorHash) {
        throw new FileVersionCenterClientError(FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
          'The current document changed. Reload the timeline before comparing.', 409, false);
      }
      const selection = result.response.candidate.selection;
      if (selection.kind !== request.candidate.kind || selection.id !== request.candidate.id
        || (typeof options.proposalVersion === 'string' && result.actionFence.proposalVersion !== options.proposalVersion)) {
        throw new FileVersionCenterClientError(FILE_VERSION_CENTER_ERROR_CODES.staleSelection,
          'The selected proposal changed. Reload the timeline before comparing.', 409, false);
      }
      return result;
    },
  });
}

export function mergeFileVersionComparePayload(
  previous: FileVersionComparePayload,
  next: FileVersionComparePayload,
): FileVersionComparePayload {
  const previousSelection = previous.response.candidate.selection;
  const nextSelection = next.response.candidate.selection;
  if (previous.response.current.fence.sha256 !== next.response.current.fence.sha256
    || previous.response.current.fence.revisionId !== next.response.current.fence.revisionId
    || previous.response.current.fence.stateVectorHash !== next.response.current.fence.stateVectorHash
    || previous.actionFence.proposalVersion !== next.actionFence.proposalVersion
    || previousSelection.kind !== nextSelection.kind
    || previousSelection.id !== nextSelection.id) {
    throw new Error('The comparison page belongs to another document state.');
  }
  const hunks = new Map(previous.response.hunks.map((hunk) => [hunk.id, hunk]));
  next.response.hunks.forEach((hunk) => hunks.set(hunk.id, hunk));
  return {
    response: { ...next.response, hunks: [...hunks.values()] },
    preview: previous.preview,
    actionFence: previous.actionFence,
  };
}
