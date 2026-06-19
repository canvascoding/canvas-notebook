import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { getFileStats } from '@/app/lib/filesystem/workspace-files';
import { isMarpMarkdown } from '@/app/lib/marp/detect';
import { renderMarpMarkdownToHtmlDocument } from '@/app/lib/marp/render';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

const READ_SIZE_LIMIT = 5 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const body = await request.json().catch(() => null);
    const filePath = body?.path;
    const markdown = body?.content;

    if (!filePath || typeof filePath !== 'string') {
      return NextResponse.json({ success: false, error: 'Path is required' }, { status: 400 });
    }

    if (typeof markdown !== 'string') {
      return NextResponse.json({ success: false, error: 'Markdown content is required' }, { status: 400 });
    }

    const extension = path.extname(filePath).toLowerCase();
    if (!['.md', '.markdown'].includes(extension)) {
      return NextResponse.json({ success: false, error: 'File must be a markdown file (.md, .markdown)' }, { status: 400 });
    }

    if (!isMarpMarkdown(filePath, markdown)) {
      return NextResponse.json({ success: false, error: 'File is not a Marp slide deck' }, { status: 400 });
    }

    if (Buffer.byteLength(markdown, 'utf-8') > READ_SIZE_LIMIT) {
      return NextResponse.json({ success: false, error: 'File is too large to preview' }, { status: 413 });
    }

    await getFileStats(filePath, fileOptions);

    const html = await renderMarpMarkdownToHtmlDocument(markdown, {
      filePath,
      title: path.basename(filePath),
      fileOptions,
    });

    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-cache',
      },
    });
  } catch (error) {
    console.error('[API] Marp preview error:', error);

    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    const message = error instanceof Error ? error.message : 'Failed to render Marp preview';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
