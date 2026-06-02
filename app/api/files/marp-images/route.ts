import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { auth } from '@/app/lib/auth';
import { getFileStats, readFile, resolveExistingWorkspacePath } from '@/app/lib/filesystem/workspace-files';
import { findChromiumExecutable } from '@/app/lib/pdf/browser';
import { isMarpMarkdown } from '@/app/lib/marp/detect';

const EXPORT_TIMEOUT_MS = 60_000;
const READ_SIZE_LIMIT = 5 * 1024 * 1024;

type ImageFormat = 'png' | 'jpeg';

function isImageFormat(value: unknown): value is ImageFormat {
  return value === 'png' || value === 'jpeg';
}

function getMarpCliPath() {
  return path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'marp.cmd' : 'marp');
}

function runMarpCli(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(getMarpCliPath(), args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('MARP_EXPORT_TIMEOUT'));
    }, EXPORT_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `Marp CLI exited with code ${code}`));
    });
  });
}

function getZipDownloadName(filePath: string, format: ImageFormat) {
  const baseName = path.basename(filePath).replace(/\.(marp|slides)\.(md|markdown)$/i, '').replace(/\.(md|markdown)$/i, '');
  return `${baseName || 'slides'}-${format}-slides.zip`;
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let tempDir: string | null = null;

  try {
    const body = await request.json().catch(() => null);
    const filePath = body?.path;
    const format = body?.format ?? 'png';

    if (!filePath || typeof filePath !== 'string') {
      return NextResponse.json({ success: false, error: 'Path is required' }, { status: 400 });
    }

    if (!isImageFormat(format)) {
      return NextResponse.json({ success: false, error: 'Format must be png or jpeg' }, { status: 400 });
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

    const inputPath = await resolveExistingWorkspacePath(filePath);
    const inputDir = path.dirname(inputPath);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-marp-images-'));
    const outputPath = path.join(tempDir, `slide.${format === 'jpeg' ? 'jpg' : 'png'}`);
    const chromiumPath = findChromiumExecutable();

    await runMarpCli([
      '--images',
      format,
      '--allow-local-files',
      '--no-config-file',
      '--browser-path',
      chromiumPath,
      '--output',
      outputPath,
      inputPath,
    ], inputDir);

    const exportedFiles = (await fs.readdir(tempDir))
      .filter((fileName) => fileName.toLowerCase().endsWith(format === 'jpeg' ? '.jpg' : '.png'))
      .sort();

    if (exportedFiles.length === 0) {
      throw new Error('Marp CLI did not create image files');
    }

    const zip = new JSZip();
    for (const fileName of exportedFiles) {
      const buffer = await fs.readFile(path.join(tempDir, fileName));
      zip.file(fileName, buffer);
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${getZipDownloadName(filePath, format)}"`,
        'Content-Length': zipBuffer.length.toString(),
        'Cache-Control': 'private, no-cache',
      },
    });
  } catch (error) {
    console.error('[API] Marp image export error:', error);

    if (error instanceof Error && error.message === 'MARP_EXPORT_TIMEOUT') {
      return NextResponse.json({ success: false, error: 'Marp image export timed out. Try again.' }, { status: 504 });
    }

    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    const message = error instanceof Error ? error.message : 'Failed to export Marp images';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
