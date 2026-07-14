import 'server-only';

import path from 'node:path';

import {
  isMarkdownEmailAttachmentName,
  markdownEmailAttachmentPdfName,
} from '@/app/lib/email/attachment-types';
import { assertBrowserExportAvailable } from '@/app/lib/pi/browser/settings-service';
import { generatePdfFromHtml } from '@/app/lib/pdf/browser';
import {
  getCachedMarkdownHtmlDocument,
  resolveMarkdownExportBrandState,
} from '@/app/lib/pdf/markdown-export-cache';
import { getMarkdownPdfRenderOptions } from '@/app/lib/pdf/markdown-brand';
import { readWorkspaceBrandLogoDataUri } from '@/app/lib/workspaces/brand-logo-service';
import type { WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';

export function assertMarkdownPdfExportPath(filePath: string): void {
  if (!isMarkdownEmailAttachmentName(filePath)) {
    throw new Error('File must be a markdown file (.md, .mdx, .markdown)');
  }
}

export function getMarkdownPdfAttachmentName(filePath: string): string {
  return markdownEmailAttachmentPdfName(path.basename(filePath));
}

export async function renderMarkdownWorkspaceFileToPdf(
  filePath: string,
  fileOptions?: WorkspaceFileOperationOptions
): Promise<Buffer> {
  assertMarkdownPdfExportPath(filePath);
  await assertBrowserExportAvailable();

  const brandState = await resolveMarkdownExportBrandState(fileOptions);
  const html = await getCachedMarkdownHtmlDocument(filePath, fileOptions, brandState);
  const brandLogoDataUri = await readWorkspaceBrandLogoDataUri(
    brandState.profile,
    fileOptions ?? {},
  );
  return generatePdfFromHtml(
    html,
    getMarkdownPdfRenderOptions(brandState.profile, brandLogoDataUri),
  );
}
