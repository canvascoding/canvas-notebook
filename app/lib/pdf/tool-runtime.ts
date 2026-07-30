import 'server-only';

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { filterSafeEnv } from '@/app/lib/security/env-allowlist';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import {
  ensureAgentRuntimeTempDir,
  getAgentRuntimeTempEnv,
} from '@/app/lib/pi/agent-runtime-temp';

const PDF_RUNTIME_TIMEOUT_MS = 90_000;
const PDF_RUNTIME_MAX_BUFFER = 2 * 1024 * 1024;

export type PdfMarkdownConversionMetadata = {
  pages: number;
  title: string;
  bodyFontSize: number;
  warnings: string[];
  markdownBytes: number;
};

export type PdfTransformRotation = {
  pages: number[];
  degrees: 90 | 180 | 270;
};

export type PdfTransformOutput = {
  pages: number[];
  rotations?: PdfTransformRotation[];
};

export type PdfTransformResult = {
  sourcePageCount: number;
  outputs: Array<{
    content: Buffer;
    pages: number[];
    pageCount: number;
    bytes: number;
  }>;
};

function resolvePdfRuntimeScript(): string {
  const appRoot = process.env.CANVAS_APP_ROOT?.trim() || process.cwd();
  return path.join(appRoot, 'scripts', 'pdf-tool-runtime.py');
}

function resolvePythonExecutable(): string {
  return process.env.CANVAS_PYTHON_PATH?.trim() || 'python3';
}

async function createPdfRuntimeTempDir(): Promise<string> {
  const executionContext = getAgentExecutionContext();
  const root = executionContext
    ? await ensureAgentRuntimeTempDir(executionContext)
    : os.tmpdir();
  return fs.mkdtemp(path.join(root, 'canvas-pdf-tool-'));
}

function runPython(
  args: string[],
  options: {
    tempDir: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<void> {
  const safeEnv = {
    ...filterSafeEnv(process.env),
    ...getAgentRuntimeTempEnv(options.tempDir),
  };
  return new Promise((resolve, reject) => {
    execFile(
      resolvePythonExecutable(),
      [resolvePdfRuntimeScript(), ...args],
      {
        encoding: 'utf8',
        env: safeEnv as NodeJS.ProcessEnv,
        maxBuffer: PDF_RUNTIME_MAX_BUFFER,
        signal: options.signal,
        timeout: options.timeoutMs ?? PDF_RUNTIME_TIMEOUT_MS,
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = stderr.trim();
        reject(new Error(detail || error.message, { cause: error }));
      },
    );
  });
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

export async function convertPdfFileToMarkdown(input: {
  inputPath: string;
  sourceLabel: string;
  signal?: AbortSignal;
}): Promise<{ markdown: string; metadata: PdfMarkdownConversionMetadata }> {
  const tempDir = await createPdfRuntimeTempDir();
  const markdownPath = path.join(tempDir, 'converted.md');
  const metadataPath = path.join(tempDir, 'metadata.json');
  try {
    await runPython([
      'to-markdown',
      '--input',
      input.inputPath,
      '--output',
      markdownPath,
      '--metadata',
      metadataPath,
      '--source-label',
      input.sourceLabel,
    ], {
      tempDir,
      signal: input.signal,
    });
    const [markdown, metadata] = await Promise.all([
      fs.readFile(markdownPath, 'utf8'),
      readJsonFile<PdfMarkdownConversionMetadata>(metadataPath),
    ]);
    if (!markdown.trim()) {
      throw new Error('PDF conversion produced empty Markdown.');
    }
    return { markdown, metadata };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function transformPdfFile(input: {
  inputPath: string;
  outputs: PdfTransformOutput[];
  signal?: AbortSignal;
}): Promise<PdfTransformResult> {
  const tempDir = await createPdfRuntimeTempDir();
  const requestPath = path.join(tempDir, 'request.json');
  const metadataPath = path.join(tempDir, 'metadata.json');
  const outputPaths = input.outputs.map((_, index) => path.join(tempDir, `output-${index + 1}.pdf`));
  try {
    await fs.writeFile(requestPath, `${JSON.stringify({
      outputs: input.outputs.map((output, index) => ({
        path: outputPaths[index],
        pages: output.pages,
        rotations: output.rotations ?? [],
      })),
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await runPython([
      'transform',
      '--input',
      input.inputPath,
      '--request',
      requestPath,
      '--metadata',
      metadataPath,
    ], {
      tempDir,
      signal: input.signal,
    });
    const metadata = await readJsonFile<{
      sourcePageCount: number;
      outputs: Array<{
        path: string;
        pages: number[];
        pageCount: number;
        bytes: number;
      }>;
    }>(metadataPath);
    if (metadata.outputs.length !== outputPaths.length) {
      throw new Error('PDF runtime returned an unexpected output count.');
    }
    const contents = await Promise.all(outputPaths.map((outputPath) => fs.readFile(outputPath)));
    contents.forEach((content, index) => {
      if (content.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error(`PDF runtime output ${index + 1} is not a valid PDF file.`);
      }
    });
    return {
      sourcePageCount: metadata.sourcePageCount,
      outputs: metadata.outputs.map((output, index) => ({
        content: contents[index],
        pages: output.pages,
        pageCount: output.pageCount,
        bytes: output.bytes,
      })),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
