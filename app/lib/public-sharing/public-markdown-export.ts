import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isMarpMarkdown } from '@/app/lib/marp/detect';
import { renderMarpMarkdownToHtmlDocument } from '@/app/lib/marp/render';
import { getCachedMarkdownHtmlDocument } from '@/app/lib/pdf/markdown-export-cache';
import {
  resolvePublicShareToken,
  type PublicShareResolution,
} from '@/app/lib/public-sharing/public-file-shares';

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

type ResolvedPublicMarkdownShare = Extract<PublicShareResolution, { ok: true }>;

type PublicMarkdownShareResolution = {
  ok: true;
  resolved: ResolvedPublicMarkdownShare;
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

export function publicMarpPreviewPath(token: string): string {
  return `/public/marp-preview/${encodeURIComponent(token)}`;
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

async function resolvePublicMarkdownShare(token: string): Promise<PublicMarkdownShareResolution> {
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

  return { ok: true, resolved };
}

export async function getPublicMarkdownExport(token: string): Promise<PublicMarkdownExportResult> {
  const publicMarkdown = await resolvePublicMarkdownShare(token);
  if (!publicMarkdown.ok) return publicMarkdown;

  const { resolved } = publicMarkdown;

  const html = await getCachedMarkdownHtmlDocument(resolved.workspacePath, { workspace: resolved.workspace });
  return {
    ok: true,
    fileName: resolved.share.fileName,
    workspacePath: resolved.workspacePath,
    html,
  };
}

export async function getPublicMarpPreview(token: string): Promise<PublicMarkdownExportResult> {
  const publicMarkdown = await resolvePublicMarkdownShare(token);
  if (!publicMarkdown.ok) return publicMarkdown;

  const { resolved } = publicMarkdown;
  const markdown = await fs.readFile(resolved.fullPath, 'utf8');
  if (!isMarpMarkdown(resolved.workspacePath, markdown)) {
    return {
      ok: false,
      status: 400,
      error: 'Public Marp preview is only available for Marp Markdown files.',
    };
  }

  const html = await renderMarpMarkdownToHtmlDocument(markdown, {
    filePath: resolved.workspacePath,
    title: resolved.share.fileName,
    fileOptions: { workspace: resolved.workspace },
  });

  return {
    ok: true,
    fileName: resolved.share.fileName,
    workspacePath: resolved.workspacePath,
    html,
  };
}
