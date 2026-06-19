import { NextRequest, NextResponse } from 'next/server';
import { getCachedMarkdownHtmlDocument } from '@/app/lib/pdf/markdown-export-cache';
import path from 'path';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');

    if (!filePath) {
      return NextResponse.json(
        { success: false, error: 'Path parameter is required' },
        { status: 400 }
      );
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!['.md', '.mdx', '.markdown'].includes(ext)) {
      return NextResponse.json(
        { success: false, error: 'File must be a markdown file (.md, .mdx, .markdown)' },
        { status: 400 }
      );
    }

    const htmlDocument = await getCachedMarkdownHtmlDocument(filePath, fileOptions);

    return new NextResponse(htmlDocument, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-cache',
      },
    });
  } catch (error) {
    console.error('[API] Markdown export error:', error);

    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    if (error && typeof error === 'object' && 'statusCode' in error && (error as { statusCode: number }).statusCode === 413) {
      return NextResponse.json({ success: false, error: 'File is too large to export' }, { status: 413 });
    }

    const message = error instanceof Error ? error.message : 'Failed to export markdown file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
