import 'server-only';

import path from 'node:path';

import { notFound } from 'next/navigation';

import { PublicFilePreview } from '@/app/components/public-sharing/PublicFilePreview';
import { PublicExcalidrawViewer } from '@/app/components/public-sharing/PublicExcalidrawViewer';
import { isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import { isMarpMarkdown } from '@/app/lib/marp/detect';
import {
  publicMarkdownExportPath,
  publicMarkdownPdfPath,
  publicMarpPreviewPath,
} from '@/app/lib/public-sharing/public-markdown-export';
import { rewritePublicMarkdownImageSources, rewritePublicNativeImageSources } from '@/app/lib/public-sharing/public-markdown-images';
import type { PublicShareResolution } from '@/app/lib/public-sharing/public-file-shares';
import type { PublicPreviewKind } from '@/app/lib/public-sharing/public-preview-types';
import { assertPublicShareStillActive, readPublicShareText, PublicShareReadError } from '@/app/lib/public-sharing/public-share-text';
import { exportNativePublicSnapshot, nativePublicExportMetadata, PublicShareNativeExportError } from '@/app/lib/public-sharing/native-public-export';

type ResolvedPublicShare = Extract<PublicShareResolution, { ok: true }>;

const TEXT_PREVIEW_SIZE_LIMIT = 5 * 1024 * 1024;
const EXCALIDRAW_PREVIEW_SIZE_LIMIT = 25 * 1024 * 1024;

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);
const HTML_EXTENSIONS = new Set(['html', 'htm']);
const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'csv', 'xls', 'pptx']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const PDF_EXTENSIONS = new Set(['pdf']);
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov']);
const CODE_EXTENSIONS = new Set([
  'txt',
  'log',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'json',
  'css',
  'scss',
  'sass',
  'less',
  'xml',
  'yml',
  'yaml',
  'env',
  'gitignore',
  'sh',
  'bash',
  'zsh',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'php',
  'sql',
  'toml',
]);

function getExtension(fileName: string) {
  return path.posix.extname(fileName).slice(1).toLowerCase();
}

function publicAssetPath(token: string, fileName: string): string {
  return `/public/files/${encodeURIComponent(token)}/${encodeURIComponent(fileName)}`;
}

function publicDownloadPath(token: string, fileName: string): string {
  return `${publicAssetPath(token, fileName)}?download=1`;
}

export function publicShortPreviewPath(shortCode: string): string {
  return `/p/${encodeURIComponent(shortCode)}`;
}

function resolvePreviewKind(fileName: string, mimeType: string): PublicPreviewKind {
  const extension = getExtension(fileName);
  const lowerMimeType = mimeType.toLowerCase();

  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  if (HTML_EXTENSIONS.has(extension) || lowerMimeType.includes('text/html')) return 'html';
  if (IMAGE_EXTENSIONS.has(extension) || lowerMimeType.startsWith('image/')) return 'image';
  if (VIDEO_EXTENSIONS.has(extension) || lowerMimeType.startsWith('video/')) return 'video';
  if (AUDIO_EXTENSIONS.has(extension) || lowerMimeType.startsWith('audio/')) return 'audio';
  if (PDF_EXTENSIONS.has(extension) || lowerMimeType.includes('application/pdf')) return 'pdf';
  if (OFFICE_EXTENSIONS.has(extension)) return 'office';
  if (CODE_EXTENSIONS.has(extension) || lowerMimeType.startsWith('text/')) return 'code';
  return 'binary';
}

function shouldReadTextContent(previewKind: PublicPreviewKind) {
  return previewKind === 'markdown' || previewKind === 'marp' || previewKind === 'html' || previewKind === 'code';
}

export async function PublicResolvedFilePreview({ resolved }: { resolved: ResolvedPublicShare }) {
  // Native identity precedes suffix selection and never needs an export codec.
  if (resolved.kind === 'native') {
    const content = resolved.snapshot.content;
    const serializedContent = content.kind === 'plain_text' ? content.text : JSON.stringify(content);
    const previewBytes = Buffer.byteLength(serializedContent, 'utf8');
    const nativePreviewTooLarge = previewBytes > TEXT_PREVIEW_SIZE_LIMIT;
    // ProseMirror emits null-prototype attrs. Native JSON crosses the RSC
    // boundary as ordinary JSON objects, only after the preview size check.
    const previewContent = nativePreviewTooLarge ? undefined : content.kind === 'rich_text'
      ? JSON.parse(serializedContent) as typeof content : content;
    const nativeContent = previewContent?.kind === 'rich_text' ? { ...previewContent,
      document: rewritePublicNativeImageSources(previewContent.document, resolved.workspacePath, resolved.row.token, resolved.workspace.workspaceId),
    } : previewContent;
    let downloadUrl: string | undefined, downloadFileName: string | undefined;
    let markdownExportUrl: string | undefined, markdownPdfUrl: string | undefined, downloadUnavailableReason: string | undefined;
    try {
      exportNativePublicSnapshot(resolved.snapshot, resolved.exportProfile);
      const metadata = nativePublicExportMetadata(resolved.share.fileName, resolved.snapshot);
      downloadUrl = publicDownloadPath(resolved.row.token, resolved.share.fileName); downloadFileName = metadata.fileName;
      if (metadata.mimeType.startsWith('text/markdown')) {
        markdownExportUrl = publicMarkdownExportPath(resolved.row.token); markdownPdfUrl = publicMarkdownPdfPath(resolved.row.token);
      }
    } catch (error) {
      if (!(error instanceof PublicShareNativeExportError)) throw error;
      downloadUnavailableReason = error.statusCode === 413 ? 'This document is too large to download here.'
        : 'A text download is unavailable for this document.';
    }
    try { await assertPublicShareStillActive(resolved); } catch (error) {
      console.warn('[public-sharing] Native preview revalidation rejected.', {
        status: error instanceof PublicShareReadError ? error.statusCode : 503,
      });
      notFound();
    }
    return <PublicFilePreview fileName={resolved.share.fileName} mimeType={resolved.mimeType} sizeBytes={resolved.sizeBytes}
      previewKind="markdown" nativeContent={nativeContent} nativePreviewTooLarge={nativePreviewTooLarge} securityMode="strict" downloadUrl={downloadUrl}
      downloadFileName={downloadFileName} downloadUnavailableReason={downloadUnavailableReason}
      markdownExportUrl={markdownExportUrl} markdownPdfUrl={markdownPdfUrl} />;
  }
  const assetUrl = publicAssetPath(resolved.row.token, resolved.share.fileName);
  const downloadUrl = publicDownloadPath(resolved.row.token, resolved.share.fileName);
  const markdownExportUrl = publicMarkdownExportPath(resolved.row.token);
  const markdownPdfUrl = publicMarkdownPdfPath(resolved.row.token);
  const marpPreviewUrl = publicMarpPreviewPath(resolved.row.token);

  if (isExcalidrawFilePath(resolved.workspacePath)) {
    if (resolved.sizeBytes > EXCALIDRAW_PREVIEW_SIZE_LIMIT) {
      return (
        <PublicFilePreview
          fileName={resolved.share.fileName}
          mimeType={resolved.mimeType}
          sizeBytes={resolved.sizeBytes}
          previewKind="binary"
          assetUrl={assetUrl}
          downloadUrl={downloadUrl}
          securityMode={resolved.share.securityMode}
        />
      );
    }

    let content: string;
    try {
      content = await readPublicShareText(resolved, EXCALIDRAW_PREVIEW_SIZE_LIMIT);
    } catch {
      notFound();
    }

    return (
      <PublicExcalidrawViewer
        fileName={resolved.share.fileName}
        content={content}
        downloadUrl={downloadUrl}
      />
    );
  }

  let previewKind = resolvePreviewKind(resolved.share.fileName, resolved.mimeType);
  let content: string | null = null;
  if (shouldReadTextContent(previewKind) && resolved.sizeBytes <= TEXT_PREVIEW_SIZE_LIMIT) {
    try {
      content = await readPublicShareText(resolved, TEXT_PREVIEW_SIZE_LIMIT);
    } catch {
      notFound();
    }
  }

  if (previewKind === 'markdown' && content && isMarpMarkdown(resolved.share.fileName, content)) {
    previewKind = 'marp';
  }

  const publicContent = previewKind === 'markdown' && content
    ? rewritePublicMarkdownImageSources(content, resolved.workspacePath, resolved.row.token, resolved.workspace.workspaceId)
    : content;

  return (
    <PublicFilePreview
      fileName={resolved.share.fileName}
      mimeType={resolved.mimeType}
      sizeBytes={resolved.sizeBytes}
      previewKind={previewKind}
      assetUrl={assetUrl}
      downloadUrl={downloadUrl}
      content={publicContent}
      securityMode={resolved.share.securityMode}
      markdownExportUrl={markdownExportUrl}
      markdownPdfUrl={markdownPdfUrl}
      marpPreviewUrl={marpPreviewUrl}
    />
  );
}
