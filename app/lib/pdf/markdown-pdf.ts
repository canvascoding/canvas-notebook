import 'server-only';

import path from 'node:path';

import {
  isMarkdownEmailAttachmentName,
  markdownEmailAttachmentPdfName,
} from '@/app/lib/email/attachment-types';
import { generatePdfFromHtml } from '@/app/lib/pdf/browser';
import { getCachedMarkdownHtmlDocument } from '@/app/lib/pdf/markdown-export-cache';

const PDF_TIMEOUT_MS = 30_000;

export function assertMarkdownPdfExportPath(filePath: string): void {
  if (!isMarkdownEmailAttachmentName(filePath)) {
    throw new Error('File must be a markdown file (.md, .mdx, .markdown)');
  }
}

export function getMarkdownPdfAttachmentName(filePath: string): string {
  return markdownEmailAttachmentPdfName(path.basename(filePath));
}

export async function renderMarkdownWorkspaceFileToPdf(filePath: string): Promise<Buffer> {
  assertMarkdownPdfExportPath(filePath);

  const html = await getCachedMarkdownHtmlDocument(filePath);
  return Promise.race([
    generatePdfFromHtml(html),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('PDF_TIMEOUT')), PDF_TIMEOUT_MS)
    ),
  ]);
}
