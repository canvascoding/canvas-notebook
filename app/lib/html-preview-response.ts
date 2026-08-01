import 'server-only';

import { Readable } from 'node:stream';

import { NextResponse } from 'next/server';

import {
  createReadStream,
  getFileStats,
  readFile,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import {
  createHtmlPreviewDocument,
  getHtmlPreviewAssetContentType,
  HTML_PREVIEW_ASSET_CSP,
  HTML_PREVIEW_CSP,
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
  if (!isHtmlFile(input.filePath)) {
    return streamWorkspaceHtmlPreviewAsset(input.filePath, input.fileOptions);
  }

  const html = (await readFile(input.filePath, input.fileOptions)).toString('utf-8');
  const document = createHtmlPreviewDocument(html, input.filePath, input.routePrefix);
  const body = Buffer.from(document, 'utf-8');
  return new NextResponse(body, {
    status: 200,
    headers: {
      ...privatePreviewHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length.toString(),
      'Content-Security-Policy': HTML_PREVIEW_CSP,
    },
  });
}
