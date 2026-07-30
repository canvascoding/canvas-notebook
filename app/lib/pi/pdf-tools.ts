import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { type AgentTool, type AgentToolResult } from '@earendil-works/pi-agent-core';
import { PDFParse } from 'pdf-parse';
import { Type } from 'typebox';

import {
  renderMarkdownTextToPdf,
  renderMarkdownWorkspaceFileToPdf,
} from '@/app/lib/pdf/markdown-pdf';
import {
  convertPdfFileToMarkdown,
  transformPdfFile,
  type PdfTransformRotation,
} from '@/app/lib/pdf/tool-runtime';
import {
  assertAgentPathAllowed,
  getAgentWorkspaceContext,
  resolveAgentPath,
  sha256Buffer,
  writeAgentBinaryFile,
  writeAgentTextFile,
  type AgentFileChangeResult,
} from '@/app/lib/pi/agent-file-operations';
import {
  formatFileChangeResult,
  formatFileChangeResults,
} from '@/app/lib/pi/tool-file-formatters';
import type { WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';

const MAX_PDF_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_PAGE_SELECTION = 2_000;
const MAX_SPLIT_PARTS = 20;

type PdfToolResultDetails = Record<string, unknown>;

function textResult(text: string, details: PdfToolResultDetails): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

function errorResult(error: unknown, operation: string): AgentToolResult<unknown> {
  const message = error instanceof Error ? error.message : 'Unknown PDF tool error';
  return textResult(`Error: ${message}`, { operation, error: message });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('PDF tool execution aborted.');
  }
}

function normalizeWorkspaceRelativePath(
  value: string,
  label: string,
  extensions: string[],
): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw new Error(`${label} must be a non-empty workspace-relative path.`);
  }
  const slashPath = trimmed.replace(/\\/gu, '/');
  if (path.posix.isAbsolute(slashPath) || /^[a-z]:\//iu.test(slashPath)) {
    throw new Error(`${label} must be relative to the active workspace.`);
  }
  const normalized = path.posix.normalize(slashPath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must stay inside the active workspace.`);
  }
  if (!extensions.some((extension) => normalized.toLowerCase().endsWith(extension))) {
    throw new Error(`${label} must end with ${extensions.join(' or ')}.`);
  }
  return normalized;
}

function normalizeWorkspaceRelativeDirectory(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw new Error(`${label} must be a non-empty workspace-relative directory.`);
  }
  const slashPath = trimmed.replace(/\\/gu, '/');
  if (path.posix.isAbsolute(slashPath) || /^[a-z]:\//iu.test(slashPath)) {
    throw new Error(`${label} must be relative to the active workspace.`);
  }
  const normalized = path.posix.normalize(slashPath);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must stay inside the active workspace.`);
  }
  return normalized;
}

function workspaceFileOptions(): WorkspaceFileOperationOptions | undefined {
  const workspace = getAgentWorkspaceContext();
  return workspace ? { workspace } : undefined;
}

async function readPdfInput(inputPath: string): Promise<{
  relativePath: string;
  fullPath: string;
  pageCount: number;
  sha256: string;
}> {
  const relativePath = normalizeWorkspaceRelativePath(inputPath, 'inputPath', ['.pdf']);
  const fullPath = resolveAgentPath(relativePath);
  await assertAgentPathAllowed(fullPath);
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) {
    throw new Error('inputPath must point to a PDF file.');
  }
  if (stats.size > MAX_PDF_INPUT_BYTES) {
    throw new Error(`PDF exceeds the ${MAX_PDF_INPUT_BYTES}-byte tool limit.`);
  }
  const content = await fs.readFile(fullPath);
  if (content.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('inputPath does not contain a valid PDF signature.');
  }
  const parser = new PDFParse({ data: content });
  try {
    const info = await parser.getInfo();
    return {
      relativePath,
      fullPath,
      pageCount: info.total,
      sha256: sha256Buffer(content),
    };
  } finally {
    await parser.destroy();
  }
}

async function preflightOutput(input: {
  outputPath: string;
  extensions: string[];
  overwrite?: boolean;
  expectedSha256?: string;
}): Promise<string> {
  const outputPath = normalizeWorkspaceRelativePath(input.outputPath, 'outputPath', input.extensions);
  const fullPath = resolveAgentPath(outputPath);
  await assertAgentPathAllowed(fullPath);
  try {
    const current = await fs.readFile(fullPath);
    if (!input.overwrite) {
      throw new Error(`Output already exists. Set overwrite: true to replace it: ${outputPath}`);
    }
    const expectedSha256 = input.expectedSha256?.trim().toLowerCase();
    if (!expectedSha256) {
      throw new Error(`expectedSha256 is required to overwrite ${outputPath}. Read the file first.`);
    }
    if (sha256Buffer(current) !== expectedSha256) {
      throw new Error(`expectedSha256 did not match the current file: ${outputPath}`);
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return outputPath;
    }
    throw error;
  }
  return outputPath;
}

function parsePageSelection(value: string, label: string): number[] {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must contain page numbers or ranges such as 1-3,5.`);
  }
  const pages: number[] = [];
  const seen = new Set<number>();
  for (const rawPart of normalized.split(',')) {
    const part = rawPart.trim();
    const range = /^(\d+)(?:-(\d+))?$/u.exec(part);
    if (!range) {
      throw new Error(`${label} contains an invalid page range: ${part}`);
    }
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : start;
    if (start < 1 || end < start) {
      throw new Error(`${label} contains an invalid page range: ${part}`);
    }
    for (let page = start; page <= end; page += 1) {
      if (!seen.has(page)) {
        seen.add(page);
        pages.push(page);
      }
      if (pages.length > MAX_PAGE_SELECTION) {
        throw new Error(`${label} is limited to ${MAX_PAGE_SELECTION} pages.`);
      }
    }
  }
  return pages;
}

function validatePages(pages: number[], pageCount: number, label: string): number[] {
  if (pages.length === 0) {
    throw new Error(`${label} must contain at least one page.`);
  }
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new Error(`${label} page ${page} is outside the valid range 1-${pageCount}.`);
    }
  }
  return pages;
}

async function writePdfOutput(input: {
  outputPath: string;
  content: Buffer;
  overwrite?: boolean;
  expectedSha256?: string;
  operation: string;
}): Promise<AgentFileChangeResult> {
  if (input.content.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('Generated output is not a valid PDF.');
  }
  return writeAgentBinaryFile({
    path: input.outputPath,
    content: input.content,
    overwrite: input.overwrite,
    expectedSha256: input.expectedSha256,
    operation: input.operation,
  });
}

const overwriteParameters = {
  overwrite: Type.Optional(Type.Boolean({
    description: 'Replace an existing output only when true. Defaults to false.',
  })),
  expectedSha256: Type.Optional(Type.String({
    description: 'Required with overwrite: true. Current SHA-256 returned by read.',
  })),
};

export function createPdfTools(): AgentTool[] {
  const createPdf: AgentTool = {
    name: 'create_pdf',
    label: 'Creating PDF',
    description: 'Creates a styled PDF in the active workspace from either inline Markdown or a workspace Markdown file. Uses the same Canvas renderer, workspace branding, Mermaid, KaTeX, tables, and image handling as Share PDF. Exactly one of markdown or sourcePath is required. outputPath must be workspace-relative; the tool never starts a browser download.',
    executionMode: 'sequential',
    parameters: Type.Object({
      markdown: Type.Optional(Type.String({ description: 'Inline Markdown to render. Use instead of sourcePath.' })),
      sourcePath: Type.Optional(Type.String({ description: 'Workspace-relative .md, .mdx, or .markdown source file. Use instead of markdown.' })),
      outputPath: Type.String({ description: 'Workspace-relative destination ending in .pdf.' }),
      title: Type.Optional(Type.String({ description: 'Document title for inline Markdown. Defaults to the output filename.' })),
      assetBasePath: Type.Optional(Type.String({ description: 'Workspace-relative base directory for images referenced by inline Markdown. Defaults to the workspace root.' })),
      ...overwriteParameters,
    }),
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as {
        markdown?: string;
        sourcePath?: string;
        outputPath: string;
        title?: string;
        assetBasePath?: string;
        overwrite?: boolean;
        expectedSha256?: string;
      };
      try {
        throwIfAborted(signal);
        const hasMarkdown = typeof params.markdown === 'string';
        const hasSourcePath = typeof params.sourcePath === 'string' && params.sourcePath.trim().length > 0;
        if (hasMarkdown === hasSourcePath) {
          throw new Error('Provide exactly one of markdown or sourcePath.');
        }
        if (hasMarkdown && !params.markdown!.trim()) {
          throw new Error('markdown must contain content.');
        }
        const outputPath = await preflightOutput({
          outputPath: params.outputPath,
          extensions: ['.pdf'],
          overwrite: params.overwrite,
          expectedSha256: params.expectedSha256,
        });
        let pdf: Buffer;
        if (hasSourcePath) {
          const sourcePath = normalizeWorkspaceRelativePath(
            params.sourcePath!,
            'sourcePath',
            ['.md', '.mdx', '.markdown'],
          );
          pdf = await renderMarkdownWorkspaceFileToPdf(sourcePath, workspaceFileOptions());
        } else {
          const assetBasePath = params.assetBasePath?.trim()
            ? normalizeWorkspaceRelativeDirectory(params.assetBasePath, 'assetBasePath')
            : '.';
          pdf = await renderMarkdownTextToPdf(params.markdown!, {
            title: params.title?.trim() || path.posix.basename(outputPath, '.pdf'),
            assetBasePath,
            fileOptions: workspaceFileOptions(),
          });
        }
        throwIfAborted(signal);
        const file = await writePdfOutput({
          outputPath,
          content: pdf,
          overwrite: params.overwrite,
          expectedSha256: params.expectedSha256,
          operation: 'create_pdf',
        });
        return textResult(formatFileChangeResult(file), {
          operation: 'create_pdf',
          outputPath,
          source: hasSourcePath ? params.sourcePath : 'inline_markdown',
          file,
        });
      } catch (error) {
        return errorResult(error, 'create_pdf');
      }
    },
  };

  const pdfToMarkdown: AgentTool = {
    name: 'pdf_to_markdown',
    label: 'Converting PDF to Markdown',
    description: 'Converts a workspace PDF to semantic Markdown while preserving page order, page markers, headings inferred from font sizes, bold/italic text, lists, and detected tables. The output records source metadata and warns when OCR or image extraction would be required. It does not claim pixel-perfect PDF layout preservation.',
    executionMode: 'sequential',
    parameters: Type.Object({
      inputPath: Type.String({ description: 'Workspace-relative source PDF.' }),
      outputPath: Type.String({ description: 'Workspace-relative destination ending in .md or .markdown.' }),
      ...overwriteParameters,
    }),
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as {
        inputPath: string;
        outputPath: string;
        overwrite?: boolean;
        expectedSha256?: string;
      };
      try {
        throwIfAborted(signal);
        const input = await readPdfInput(params.inputPath);
        const outputPath = await preflightOutput({
          outputPath: params.outputPath,
          extensions: ['.md', '.markdown'],
          overwrite: params.overwrite,
          expectedSha256: params.expectedSha256,
        });
        const converted = await convertPdfFileToMarkdown({
          inputPath: input.fullPath,
          sourceLabel: input.relativePath,
          signal,
        });
        throwIfAborted(signal);
        const file = await writeAgentTextFile({
          path: outputPath,
          content: converted.markdown,
          expectedSha256: params.overwrite ? params.expectedSha256 : undefined,
          operation: 'pdf_to_markdown',
        });
        return textResult([
          formatFileChangeResult(file),
          '',
          `Converted pages: ${converted.metadata.pages}`,
          `Detected body font size: ${converted.metadata.bodyFontSize} pt`,
          converted.metadata.warnings.length > 0
            ? `Warnings:\n${converted.metadata.warnings.map((warning) => `- ${warning}`).join('\n')}`
            : 'Warnings: none',
        ].join('\n'), {
          operation: 'pdf_to_markdown',
          inputPath: input.relativePath,
          inputSha256: input.sha256,
          outputPath,
          conversion: converted.metadata,
          file,
        });
      } catch (error) {
        return errorResult(error, 'pdf_to_markdown');
      }
    },
  };

  const splitPdf: AgentTool = {
    name: 'split_pdf',
    label: 'Splitting PDF',
    description: 'Splits or extracts selected pages from one workspace PDF into one or more workspace PDFs. Each part accepts 1-based page ranges such as 1-3,5. All outputs are generated before workspace files are written.',
    executionMode: 'sequential',
    parameters: Type.Object({
      inputPath: Type.String({ description: 'Workspace-relative source PDF.' }),
      parts: Type.Array(Type.Object({
        pages: Type.String({ description: '1-based pages or ranges, for example 1-3,5.' }),
        outputPath: Type.String({ description: 'Workspace-relative destination ending in .pdf.' }),
        ...overwriteParameters,
      }), { minItems: 1, maxItems: MAX_SPLIT_PARTS }),
    }),
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as {
        inputPath: string;
        parts: Array<{
          pages: string;
          outputPath: string;
          overwrite?: boolean;
          expectedSha256?: string;
        }>;
      };
      try {
        throwIfAborted(signal);
        const input = await readPdfInput(params.inputPath);
        if (!Array.isArray(params.parts) || params.parts.length === 0 || params.parts.length > MAX_SPLIT_PARTS) {
          throw new Error(`parts must contain 1-${MAX_SPLIT_PARTS} outputs.`);
        }
        const prepared = await Promise.all(params.parts.map(async (part, index) => ({
          ...part,
          pagesParsed: validatePages(parsePageSelection(part.pages, `parts[${index}].pages`), input.pageCount, `parts[${index}].pages`),
          outputPath: await preflightOutput({
            outputPath: part.outputPath,
            extensions: ['.pdf'],
            overwrite: part.overwrite,
            expectedSha256: part.expectedSha256,
          }),
        })));
        const uniqueOutputs = new Set(prepared.map((part) => part.outputPath));
        if (uniqueOutputs.size !== prepared.length) {
          throw new Error('Each split part must use a unique outputPath.');
        }
        const transformed = await transformPdfFile({
          inputPath: input.fullPath,
          outputs: prepared.map((part) => ({ pages: part.pagesParsed })),
          signal,
        });
        throwIfAborted(signal);
        const files: AgentFileChangeResult[] = [];
        for (const [index, part] of prepared.entries()) {
          files.push(await writePdfOutput({
            outputPath: part.outputPath,
            content: transformed.outputs[index].content,
            overwrite: part.overwrite,
            expectedSha256: part.expectedSha256,
            operation: 'split_pdf',
          }));
        }
        return textResult(formatFileChangeResults(files), {
          operation: 'split_pdf',
          inputPath: input.relativePath,
          inputSha256: input.sha256,
          sourcePageCount: transformed.sourcePageCount,
          outputs: prepared.map((part, index) => ({
            outputPath: part.outputPath,
            pages: transformed.outputs[index].pages,
            pageCount: transformed.outputs[index].pageCount,
            file: files[index],
          })),
        });
      } catch (error) {
        return errorResult(error, 'split_pdf');
      }
    },
  };

  const editPdfPages: AgentTool = {
    name: 'edit_pdf_pages',
    label: 'Editing PDF pages',
    description: 'Creates an edited PDF by reordering pages, deleting selected pages, and rotating source pages by 90, 180, or 270 degrees. pageOrder is the complete final 1-based source page order and may not be combined with deletePages. This page-level operation does not rewrite text inside a PDF.',
    executionMode: 'sequential',
    parameters: Type.Object({
      inputPath: Type.String({ description: 'Workspace-relative source PDF.' }),
      outputPath: Type.String({ description: 'Workspace-relative destination ending in .pdf.' }),
      pageOrder: Type.Optional(Type.Array(Type.Number({
        description: 'Complete final list of 1-based source page numbers. Supports reordering.',
        minimum: 1,
      }), { minItems: 1, maxItems: MAX_PAGE_SELECTION })),
      deletePages: Type.Optional(Type.String({ description: 'Pages to remove, for example 2,4-6. Cannot be combined with pageOrder.' })),
      rotations: Type.Optional(Type.Array(Type.Object({
        pages: Type.String({ description: 'Source pages to rotate, for example 1-3,5.' }),
        degrees: Type.Union([Type.Literal(90), Type.Literal(180), Type.Literal(270)]),
      }), { maxItems: 50 })),
      ...overwriteParameters,
    }),
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as {
        inputPath: string;
        outputPath: string;
        pageOrder?: number[];
        deletePages?: string;
        rotations?: Array<{ pages: string; degrees: 90 | 180 | 270 }>;
        overwrite?: boolean;
        expectedSha256?: string;
      };
      try {
        throwIfAborted(signal);
        const input = await readPdfInput(params.inputPath);
        if (params.pageOrder && params.deletePages?.trim()) {
          throw new Error('pageOrder cannot be combined with deletePages.');
        }
        const deletedPages = new Set(
          params.deletePages?.trim()
            ? validatePages(
                parsePageSelection(params.deletePages, 'deletePages'),
                input.pageCount,
                'deletePages',
              )
            : [],
        );
        const pageOrder = params.pageOrder
          ? validatePages(params.pageOrder, input.pageCount, 'pageOrder')
          : Array.from({ length: input.pageCount }, (_, index) => index + 1)
              .filter((page) => !deletedPages.has(page));
        if (pageOrder.length === 0) {
          throw new Error('PDF page editing cannot delete every page.');
        }
        const selectedPages = new Set(pageOrder);
        const rotations: PdfTransformRotation[] = (params.rotations ?? []).map((rotation, index) => {
          const pages = validatePages(
            parsePageSelection(rotation.pages, `rotations[${index}].pages`),
            input.pageCount,
            `rotations[${index}].pages`,
          );
          const missingPage = pages.find((page) => !selectedPages.has(page));
          if (missingPage) {
            throw new Error(`Rotation references source page ${missingPage}, which is not in the final page selection.`);
          }
          return { pages, degrees: rotation.degrees };
        });
        const outputPath = await preflightOutput({
          outputPath: params.outputPath,
          extensions: ['.pdf'],
          overwrite: params.overwrite,
          expectedSha256: params.expectedSha256,
        });
        const transformed = await transformPdfFile({
          inputPath: input.fullPath,
          outputs: [{ pages: pageOrder, rotations }],
          signal,
        });
        throwIfAborted(signal);
        const file = await writePdfOutput({
          outputPath,
          content: transformed.outputs[0].content,
          overwrite: params.overwrite,
          expectedSha256: params.expectedSha256,
          operation: 'edit_pdf_pages',
        });
        return textResult(formatFileChangeResult(file), {
          operation: 'edit_pdf_pages',
          inputPath: input.relativePath,
          inputSha256: input.sha256,
          sourcePageCount: input.pageCount,
          outputPath,
          pageOrder,
          rotations,
          file,
        });
      } catch (error) {
        return errorResult(error, 'edit_pdf_pages');
      }
    },
  };

  return [createPdf, pdfToMarkdown, splitPdf, editPdfPages];
}
