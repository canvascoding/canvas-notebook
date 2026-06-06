import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auth } from '@/app/lib/auth';
import { getFileStats, readFile } from '@/app/lib/filesystem/workspace-files';
import { getMarpExportBaseName, runMarpCli, writeMarpCliInput } from '@/app/lib/marp/cli';
import { isMarpMarkdown } from '@/app/lib/marp/detect';
import { findChromiumExecutable } from '@/app/lib/pdf/browser';

const READ_SIZE_LIMIT = 5 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let tempDir: string | null = null;

  try {
    const body = await request.json().catch(() => null);
    const filePath = body?.path;

    if (!filePath || typeof filePath !== 'string') {
      return NextResponse.json({ success: false, error: 'Path is required' }, { status: 400 });
    }

    const extension = path.extname(filePath).toLowerCase();
    if (!['.md', '.markdown'].includes(extension)) {
      return NextResponse.json({ success: false, error: 'File must be a markdown file (.md, .markdown)' }, { status: 400 });
    }

    const stats = await getFileStats(filePath);
    if (stats.size > READ_SIZE_LIMIT) {
      return NextResponse.json({ success: false, error: 'File is too large to export' }, { status: 413 });
    }

    const markdown = (await readFile(filePath)).toString('utf-8');
    if (!isMarpMarkdown(filePath, markdown)) {
      return NextResponse.json({ success: false, error: 'File is not a Marp slide deck' }, { status: 400 });
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-marp-pdf-'));
    const inputPath = await writeMarpCliInput({
      tempDir,
      filePath,
      markdown,
    });
    const outputPath = path.join(tempDir, 'slides.pdf');
    const chromiumPath = findChromiumExecutable();

    await runMarpCli([
      '--pdf',
      '--no-config-file',
      '--browser-path',
      chromiumPath,
      '--output',
      outputPath,
      inputPath,
    ], tempDir);

    const pdfBuffer = await fs.readFile(outputPath);

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${getMarpExportBaseName(filePath)}-slides.pdf"`,
        'Content-Length': pdfBuffer.length.toString(),
        'Cache-Control': 'private, no-cache',
      },
    });
  } catch (error) {
    console.error('[API] Marp PDF export error:', error);

    if (error instanceof Error && error.message === 'MARP_EXPORT_TIMEOUT') {
      return NextResponse.json({ success: false, error: 'Marp PDF export timed out. Try again.' }, { status: 504 });
    }

    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    const message = error instanceof Error ? error.message : 'Failed to export Marp PDF';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
