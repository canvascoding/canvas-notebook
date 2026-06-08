import { promises as fs } from 'node:fs';
import path from 'node:path';

import { notFound } from 'next/navigation';

import { PublicFilePreview } from '@/app/components/public-sharing/PublicFilePreview';
import { PublicExcalidrawViewer } from '@/app/components/public-sharing/PublicExcalidrawViewer';
import { isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import { isMarpMarkdown } from '@/app/lib/marp/detect';
import { resolvePublicShareToken } from '@/app/lib/public-sharing/public-file-shares';
import type { PublicPreviewKind } from '@/app/lib/public-sharing/public-preview-types';

export const dynamic = 'force-dynamic';

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

interface PublicFilePreviewPageProps {
  params: Promise<{
    token: string;
    filename: string[];
  }>;
}

function getExtension(fileName: string) {
  return path.posix.extname(fileName).slice(1).toLowerCase();
}

function publicAssetPath(token: string, fileName: string): string {
  return `/public/files/${encodeURIComponent(token)}/${encodeURIComponent(fileName)}`;
}

function publicDownloadPath(token: string, fileName: string): string {
  return `${publicAssetPath(token, fileName)}?download=1`;
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

export default async function PublicFilePreviewPage({ params }: PublicFilePreviewPageProps) {
  const { token } = await params;
  const decodedToken = decodeURIComponent(token);
  const resolved = await resolvePublicShareToken(decodedToken);

  if (!resolved.ok) {
    notFound();
  }

  const assetUrl = publicAssetPath(decodedToken, resolved.share.fileName);
  const downloadUrl = publicDownloadPath(decodedToken, resolved.share.fileName);

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
      content = await fs.readFile(resolved.fullPath, 'utf8');
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
      content = await fs.readFile(resolved.fullPath, 'utf8');
    } catch {
      notFound();
    }
  }

  if (previewKind === 'markdown' && content && isMarpMarkdown(resolved.share.fileName, content)) {
    previewKind = 'marp';
  }

  return (
    <PublicFilePreview
      fileName={resolved.share.fileName}
      mimeType={resolved.mimeType}
      sizeBytes={resolved.sizeBytes}
      previewKind={previewKind}
      assetUrl={assetUrl}
      downloadUrl={downloadUrl}
      content={content}
      securityMode={resolved.share.securityMode}
    />
  );
}
