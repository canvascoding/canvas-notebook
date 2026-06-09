import 'server-only';

import path from 'node:path';

import { getCachedMarkdownHtmlDocument } from '@/app/lib/pdf/markdown-export-cache';
import { resolvePublicShareToken } from '@/app/lib/public-sharing/public-file-shares';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);

export type PublicMarkdownExportResult = {
  ok: true;
  fileName: string;
  workspacePath: string;
  html: string;
} | {
  ok: false;
  status: number;
  error: string;
};

export function publicMarkdownExportPath(token: string): string {
  return `/public/markdown-export/${encodeURIComponent(token)}`;
}

export function publicMarkdownPdfPath(token: string): string {
  return `/public/markdown-pdf/${encodeURIComponent(token)}`;
}

export function getMarkdownPdfDownloadName(filePath: string) {
  const rawBaseName = filePath.split(/[\\/]/).filter(Boolean).pop() || 'document';
  let decodedBaseName = rawBaseName;

  try {
    decodedBaseName = decodeURIComponent(rawBaseName);
  } catch {
    decodedBaseName = rawBaseName;
  }

  const baseName = decodedBaseName.trim() || 'document';
  const withoutKnownExtension = baseName.replace(/\.(md|mdx|markdown)$/i, '');
  return `${withoutKnownExtension || 'document'}.pdf`;
}

export async function getPublicMarkdownExport(token: string): Promise<PublicMarkdownExportResult> {
  const resolved = await resolvePublicShareToken(token, { recordAccess: false });
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.status,
      error: resolved.error,
    };
  }

  const extension = path.extname(resolved.workspacePath).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      status: 400,
      error: 'Public export is only available for Markdown files.',
    };
  }

  const html = await getCachedMarkdownHtmlDocument(resolved.workspacePath);
  return {
    ok: true,
    fileName: resolved.share.fileName,
    workspacePath: resolved.workspacePath,
    html,
  };
}
