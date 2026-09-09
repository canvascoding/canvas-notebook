import 'server-only';

import { Readable } from 'node:stream';

import { NextResponse } from 'next/server';

import {
  createReadStream,
  getFileStats,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import {
  getHtmlPreviewAssetContentType,
  HTML_PREVIEW_ASSET_CSP,
  isHtmlFile,
} from '@/app/lib/html-preview';

const privatePreviewHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

async function streamWorkspaceHtmlPreviewAsset(
  filePath: string,
  fileOptions: WorkspaceFileOperationOptions,
) {
  const stats = await getFileStats(filePath, fileOptions);
  const { stream } = await createReadStream(filePath, undefined, fileOptions);
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      ...privatePreviewHeaders,
      'Content-Type': getHtmlPreviewAssetContentType(filePath),
      'Content-Length': stats.size.toString(),
      'Content-Security-Policy': HTML_PREVIEW_ASSET_CSP,
    },
  });
}

export async function createWorkspaceHtmlPreviewResponse(input: {
  filePath: string;
  fileOptions: WorkspaceFileOperationOptions;
  routePrefix: string;
}) {
  if (isHtmlFile(input.filePath)) throw new Error('HTML documents require an isolated preview ticket');
  return streamWorkspaceHtmlPreviewAsset(input.filePath, input.fileOptions);
}
