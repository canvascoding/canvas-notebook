'use client';

import {
  FILE_VERSION_CENTER_API_V1,
  FILE_VERSION_CENTER_ERROR_CODES,
  parseFileVersionCenterErrorResponseV1,
  parseFileReviewPolicyV1,
  parseFileVersionTimelineResponseV1,
  type FileVersionCenterErrorCode,
  type FileVersionCenterRequestV1,
  type FileVersionTimelineResponseV1,
  type FileReviewPolicyUpdateRequestV1,
  type FileReviewPolicyV1,
} from './contracts/v1';
import { fetchReviewResolution, invalidateReviewQueries } from '@/app/lib/queries/review-queries';
import { notebookQueryKey } from '@/app/lib/queries/client';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

const FILE_VERSION_CENTER_RESOLVE_RETRY_DELAYS_MS = Object.freeze([
  150, 300, 600, 1_000, 1_500, 2_000, 2_000,
]);

export class FileVersionCenterClientError extends Error {
  constructor(
    readonly code: FileVersionCenterErrorCode | 'FVRC_TRANSPORT_ERROR',
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'FileVersionCenterClientError';
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new FileVersionCenterClientError(
      'FVRC_TRANSPORT_ERROR',
      'The version center returned an unreadable response.',
      response.status,
      response.status >= 500,
    );
  }
}

async function requestFileVersionCenter(
  request: FileVersionCenterRequestV1,
  signal?: AbortSignal,
): Promise<FileVersionTimelineResponseV1> {
  let response: Response;
  try {
    response = await fetch(FILE_VERSION_CENTER_API_V1.resolve, {
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
      'The version center could not be reached.',
      0,
      true,
    );
  }
  const payload = await responseJson(response);
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
        'The version center request failed.',
        response.status,
        response.status >= 500,
      );
    }
  }
  return parseFileVersionTimelineResponseV1(payload);
}

export async function resolveFileVersionCenter(
  request: FileVersionCenterRequestV1,
  signal?: AbortSignal,
): Promise<FileVersionTimelineResponseV1> {
  return fetchReviewResolution({
    request, signal, readiness: 'once',
    queryFn: ({ signal: querySignal }) => requestFileVersionCenter(request, querySignal),
  });
}

function waitForResolveRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('The version center request was cancelled.', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      globalThis.clearTimeout(timeout);
      reject(new DOMException('The version center request was cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Retries only the short persistence window while a newly opened collaboration
 * document is being hydrated. Authorization, validation, rollout, and other
 * permanent failures remain single-attempt and fail closed.
 */
export async function resolveFileVersionCenterWhenReady(
  request: FileVersionCenterRequestV1,
  signal?: AbortSignal,
  options: { retryDelaysMs?: readonly number[] } = {},
): Promise<FileVersionTimelineResponseV1> {
  const retryDelaysMs = options.retryDelaysMs ?? FILE_VERSION_CENTER_RESOLVE_RETRY_DELAYS_MS;
  return fetchReviewResolution({
    request, signal, readiness: retryDelaysMs,
    queryFn: async ({ signal: querySignal }) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await requestFileVersionCenter(request, querySignal);
        } catch (error) {
          if (!(error instanceof FileVersionCenterClientError)
            || error.code !== FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable
            || attempt >= retryDelaysMs.length) throw error;
          await waitForResolveRetry(retryDelaysMs[attempt], querySignal);
        }
      }
    },
  });
}

export async function updateFileReviewPolicy(
  request: FileReviewPolicyUpdateRequestV1,
  signal?: AbortSignal,
): Promise<FileReviewPolicyV1> {
  const authScope = notebookQueryKey(request.target.workspaceId)[1];
  let response: Response;
  try {
    response = await fetch(FILE_VERSION_CENTER_API_V1.policy, {
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
      'The review policy could not be reached.',
      0,
      true,
    );
  }
  const payload = await responseJson(response);
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
        'The review policy update failed.',
        response.status,
        response.status >= 500,
      );
    }
  }
  const policy = parseFileReviewPolicyV1(payload);
  await invalidateReviewQueries(request.target.workspaceId, authScope);
  return policy;
}
