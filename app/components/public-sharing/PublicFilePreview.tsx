'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, Code2, Download, Eye, FileText, Loader2, RefreshCw, Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { CodeEditor } from '@/app/components/editor/CodeEditor';
import { ImageViewer } from '@/app/components/editor/ImageViewer';
import { MarkdownEditor } from '@/app/components/editor/MarkdownEditor';
import { MediaViewer } from '@/app/components/editor/MediaViewer';
import { PdfViewer } from '@/app/components/editor/PdfViewer';
import { ShareMarkdownDialog } from '@/app/components/file-browser/ShareMarkdownDialog';
import type { PublicPreviewKind } from '@/app/lib/public-sharing/public-preview-types';
import type { PublicShareSecurityMode } from '@/app/lib/public-sharing/public-share-security';

const OfficeEditor = dynamic(() => import('@/app/components/editor/OfficeEditor').then((mod) => mod.OfficeEditor), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-background">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  ),
});

interface PublicFilePreviewProps {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewKind: PublicPreviewKind;
  assetUrl: string;
  downloadUrl: string;
  content?: string | null;
  securityMode?: PublicShareSecurityMode;
  markdownExportUrl?: string;
  markdownPdfUrl?: string;
}

type HtmlMode = 'preview' | 'code';

function getExtension(fileName: string) {
  const parts = fileName.split('.');
  if (parts.length <= 1) return '';
  return parts[parts.length - 1].toLowerCase();
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}

function UnsupportedPreview({ fileName, downloadUrl }: { fileName: string; downloadUrl: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center text-muted-foreground">
      <FileText className="h-8 w-8" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Preview unavailable</p>
        <p className="max-w-md text-xs">This shared file can be downloaded, but it cannot be previewed safely in the browser.</p>
      </div>
      <Button asChild variant="secondary">
        <a href={downloadUrl} download={fileName}>
          <Download className="h-4 w-4" />
          Download file
        </a>
      </Button>
    </div>
  );
}

function TextUnavailable({ fileName, downloadUrl }: { fileName: string; downloadUrl: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center text-muted-foreground">
      <AlertCircle className="h-8 w-8" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Preview too large</p>
        <p className="max-w-md text-xs">This text file is too large for the public preview. Download it to view the full file.</p>
      </div>
      <Button asChild variant="secondary">
        <a href={downloadUrl} download={fileName}>
          <Download className="h-4 w-4" />
          Download file
        </a>
      </Button>
    </div>
  );
}

export function PublicFilePreview({
  fileName,
  mimeType,
  sizeBytes,
  previewKind,
  assetUrl,
  downloadUrl,
  content,
  securityMode = 'strict',
  markdownExportUrl,
  markdownPdfUrl,
}: PublicFilePreviewProps) {
  const t = useTranslations('notebook');
  const [htmlMode, setHtmlMode] = useState<HtmlMode>('preview');
  const [htmlRefreshKey, setHtmlRefreshKey] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const extension = useMemo(() => getExtension(fileName), [fileName]);
  const sizeLabel = formatBytes(sizeBytes);
  const canShowTextContent = typeof content === 'string';
  const canShowHtmlCode = previewKind === 'html' && canShowTextContent;
  const canShareMarkdown = (
    (previewKind === 'markdown' || previewKind === 'marp') &&
    canShowTextContent &&
    Boolean(markdownExportUrl && markdownPdfUrl)
  );
  const htmlSandbox = securityMode === 'interactive'
    ? 'allow-scripts allow-popups allow-downloads'
    : '';

  let body: ReactNode;
  if ((previewKind === 'markdown' || previewKind === 'marp') && canShowTextContent) {
    body = <MarkdownEditor value={content} readOnly />;
  } else if ((previewKind === 'code' || (previewKind === 'html' && htmlMode === 'code')) && canShowTextContent) {
    body = <CodeEditor value={content} onChange={() => {}} readOnly path={fileName} />;
  } else if (previewKind === 'html') {
    body = (
      <iframe
        key={`${assetUrl}-${htmlRefreshKey}`}
        src={assetUrl}
        sandbox={htmlSandbox}
        className="h-full w-full border-0 bg-white"
        title={`Preview: ${fileName}`}
      />
    );
  } else if (previewKind === 'image') {
    body = <ImageViewer path={fileName} previewSrc={assetUrl} fullSrc={assetUrl} />;
  } else if (previewKind === 'video') {
    body = <MediaViewer path={fileName} kind="video" mimeType={mimeType} size={sizeBytes} sourceUrl={assetUrl} />;
  } else if (previewKind === 'audio') {
    body = <MediaViewer path={fileName} kind="audio" mimeType={mimeType} size={sizeBytes} sourceUrl={assetUrl} />;
  } else if (previewKind === 'pdf') {
    body = <PdfViewer path={fileName} sourceUrl={assetUrl} />;
  } else if (previewKind === 'office') {
    body = <OfficeEditor path={fileName} extension={extension} readOnly sourceUrl={assetUrl} />;
  } else if ((previewKind === 'markdown' || previewKind === 'marp' || previewKind === 'code') && !canShowTextContent) {
    body = <TextUnavailable fileName={fileName} downloadUrl={downloadUrl} />;
  } else {
    body = <UnsupportedPreview fileName={fileName} downloadUrl={downloadUrl} />;
  }

  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2 sm:px-4">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium">{fileName}</h1>
          <p className="truncate text-xs text-muted-foreground">
            Public read-only preview{sizeLabel ? ` · ${sizeLabel}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {previewKind === 'html' && htmlMode === 'preview' ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setHtmlRefreshKey((key) => key + 1)}
              title="Refresh preview"
              aria-label="Refresh preview"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          ) : null}
          {canShowHtmlCode ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHtmlMode((mode) => (mode === 'preview' ? 'code' : 'preview'))}
            >
              {htmlMode === 'preview' ? (
                <>
                  <Code2 className="h-4 w-4" />
                  Code
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4" />
                  Preview
                </>
              )}
            </Button>
          ) : null}
          {canShareMarkdown ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShareOpen(true)}
            >
              <Share2 className="h-4 w-4" />
              {t('share')}
            </Button>
          ) : null}
          <Button asChild variant="secondary" size="sm">
            <a href={downloadUrl} download={fileName}>
              <Download className="h-4 w-4" />
              Download
            </a>
          </Button>
        </div>
      </header>
      <section className="min-h-0 flex-1 overflow-hidden">
        {body}
      </section>
      {canShareMarkdown ? (
        <ShareMarkdownDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          filePath={fileName}
          fileName={fileName}
          markdownExportUrl={markdownExportUrl}
          markdownPdfUrl={markdownPdfUrl}
        />
      ) : null}
    </main>
  );
}
