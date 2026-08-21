import { createHash } from 'node:crypto';
import path from 'node:path';

import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { getFileStats, readFile } from '@/app/lib/filesystem/workspace-files';
import { isMarpMarkdown } from '@/app/lib/marp/detect';
import { renderMarpMarkdownToMobilePreview } from '@/app/lib/marp/render';
import { MobileFilesError, normalizeMobileFilePath } from '@/app/lib/mobile/files';
import { mobileFilesErrorResponse, mobileFilesResponseHeaders } from '@/app/lib/mobile/files-route';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

const READ_SIZE_LIMIT = 5 * 1024 * 1024;

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'mobile-marp-preview',
  });
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => null) as { path?: unknown } | null;
    const filePath = normalizeMobileFilePath(body?.path, false);
    if (!['.md', '.markdown'].includes(path.extname(filePath).toLowerCase())) {
      throw new MobileFilesError('File must be a markdown file.', 400, 'INVALID_MARP_FILE');
    }
    const fileOptions = workspaceFileOptions(workspaceResult.workspace);
    const stats = await getFileStats(filePath, fileOptions);
    if (!stats.isFile) throw new MobileFilesError('The selected path is not a file.', 400, 'NOT_A_FILE');
    if (stats.size > READ_SIZE_LIMIT) throw new MobileFilesError('File is too large to preview.', 413, 'MARP_PREVIEW_TOO_LARGE');
    const markdown = (await readFile(filePath, fileOptions)).toString('utf8');
    if (!isMarpMarkdown(filePath, markdown)) {
      throw new MobileFilesError('File is not a Marp slide deck.', 400, 'NOT_A_MARP_FILE');
    }
    const render = await renderMarpMarkdownToMobilePreview(markdown, {
      filePath,
      title: path.basename(filePath),
      fileOptions,
    });
    return NextResponse.json({
      success: true,
      render: {
        ...render,
        source: {
          path: filePath,
          sha256: createHash('sha256').update(markdown).digest('hex'),
          sizeBytes: Buffer.byteLength(markdown, 'utf8'),
          modifiedAt: new Date(stats.modified * 1_000).toISOString(),
        },
      },
    }, { headers: mobileFilesResponseHeaders });
  } catch (error) {
    return mobileFilesErrorResponse(error, '[API] Mobile Marp preview error:');
  }
}
