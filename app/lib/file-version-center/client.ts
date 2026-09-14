'use client';

import {
  FILE_VERSION_CENTER_API_V1,
  parseFileVersionCenterErrorResponseV1,
  parseFileVersionTimelineResponseV1,
  type FileVersionCenterErrorCode,
  type FileVersionCenterRequestV1,
  type FileVersionTimelineResponseV1,
} from './contracts/v1';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

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

export async function resolveFileVersionCenter(
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
