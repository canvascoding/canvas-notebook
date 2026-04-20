'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, ChevronLeft, ChevronRight, Code2, Download, Eye, FileText, Loader2, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useFileStore, type FileNode } from '@/app/store/file-store';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import { ImageViewer } from '@/app/components/editor/ImageViewer';
import { MediaViewer } from '@/app/components/editor/MediaViewer';
import { PdfViewer } from '@/app/components/editor/PdfViewer';
import dynamic from 'next/dynamic';

const OfficeEditor = dynamic(() => import('@/app/components/editor/OfficeEditor').then(mod => mod.OfficeEditor), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-background">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  ),
});

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);
const HTML_EXTENSIONS = new Set(['html', 'htm']);
const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'csv', 'xls', 'pptx']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const PDF_EXTENSIONS = new Set(['pdf']);
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'js', 'jsx', 'ts', 'tsx', 'json', 'css', 'scss', 'html',
  'yml', 'yaml', 'md', 'mdx', 'markdown', 'env', 'gitignore', 'sh', 'bash',
  'zsh', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'php', 'sql', 'toml',
]);

const MEDIA_MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac',
};

const IMAGE_NAV_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

function getExtension(path: string) {
  const parts = path.split('.');
  if (parts.length <= 1) return '';
  return parts[parts.length - 1].toLowerCase();
}

function collectNavigablePaths(nodes: FileNode[]): string[] {
  const result: string[] = [];
  const traverse = (items: FileNode[]) => {
    for (const node of items) {
      if (node.type === 'file') {
        const ext = node.name.split('.').pop()?.toLowerCase() || '';
        result.push(node.path);
      }
      if (node.children) traverse(node.children);
    }
  };
  traverse(nodes);
  return result;
}

interface FilePreviewDialogProps {
  path: string | null;
  fileTree: FileNode[];
  onClose: () => void;
}

export function FilePreviewDialog({ path, fileTree, onClose }: FilePreviewDialogProps) {
  const t = useTranslations('notebook');
  const [htmlViewMode, setHtmlViewMode] = useState<'code' | 'preview'>('preview');
  const [htmlRefreshKey, setHtmlRefreshKey] = useState(0);
  const [activePath, setActivePath] = useState<string | null>(null);
  const { currentFile, isLoadingFile, fileError, loadFile, downloadFile } = useFileStore();

  useEffect(() => {
    if (path) {
      setActivePath(path);
      void loadFile(path, true);
    } else {
      setActivePath(null);
    }
  }, [path, loadFile]);

  const allPaths = useMemo(() => collectNavigablePaths(fileTree), [fileTree]);
  const currentIndex = activePath ? allPaths.indexOf(activePath) : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < allPaths.length - 1;

  const handlePrev = () => {
    if (currentIndex > 0) {
      const prevPath = allPaths[currentIndex - 1];
      setActivePath(prevPath);
      void loadFile(prevPath, true);
    }
  };

  const handleNext = () => {
    if (currentIndex >= 0 && currentIndex < allPaths.length - 1) {
      const nextPath = allPaths[currentIndex + 1];
      setActivePath(nextPath);
      void loadFile(nextPath, true);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!path) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); handlePrev(); }
      if (event.key === 'ArrowRight') { event.preventDefault(); handleNext(); }
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [path, onClose]);

  if (!path) return null;

  const displayPath = activePath || path;
  const fileName = displayPath.split('/').pop() || displayPath;
  const extension = getExtension(displayPath);

  const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);
  const isHtml = HTML_EXTENSIONS.has(extension);
  const isOffice = OFFICE_EXTENSIONS.has(extension);
  const isImage = IMAGE_EXTENSIONS.has(extension);
  const isPdf = PDF_EXTENSIONS.has(extension);
  const isAudio = AUDIO_EXTENSIONS.has(extension);
  const isVideo = VIDEO_EXTENSIONS.has(extension);
  const isText = extension === '' || TEXT_EXTENSIONS.has(extension);
  const isBinary = !isText && !isImage && !isPdf && !isMarkdown && !isHtml && !isAudio && !isVideo && !isOffice;
  const mediaMimeType = MEDIA_MIME_TYPES[extension];

  const renderContent = () => {
    if (isLoadingFile) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (fileError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <p className="text-sm text-destructive">{fileError}</p>
          <Button variant="secondary" size="sm" onClick={() => void downloadFile(displayPath)}>
            <Download className="h-4 w-4" />
            {t('downloadFile')}
          </Button>
        </div>
      );
    }

    if (!currentFile) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {t('selectFileToPreview')}
        </div>
      );
    }

    if (isBinary) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <FileText className="h-8 w-8" />
          <p className="text-sm">{t('binaryPreviewUnavailable')}</p>
          <Button variant="secondary" onClick={() => void downloadFile(currentFile.path)}>
            <Download className="h-4 w-4" />
            {t('downloadFile')}
          </Button>
        </div>
      );
    }

    if (isImage) return <ImageViewer path={currentFile.path} />;
    if (isOffice) return <OfficeEditor key={currentFile.path} path={currentFile.path} extension={extension} updateDraft={() => {}} onChange={() => {}} />;
    if (isPdf) return <PdfViewer path={currentFile.path} />;
    if (isAudio) return <MediaViewer path={currentFile.path} kind="audio" mimeType={mediaMimeType} size={currentFile.stats?.size} />;
    if (isVideo) return <MediaViewer path={currentFile.path} kind="video" mimeType={mediaMimeType} size={currentFile.stats?.size} />;
    if (isHtml) {
      const sourceUrl = toMediaUrl(currentFile.path);
      if (htmlViewMode === 'code') {
        return (
          <pre className="h-full overflow-auto bg-background p-4 text-sm font-mono whitespace-pre-wrap">
            {currentFile.content || ''}
          </pre>
        );
      }
      return (
        <iframe
          key={htmlRefreshKey}
          src={sourceUrl}
          sandbox="allow-scripts allow-same-origin"
          className="h-full w-full border-0 bg-white"
          title={`Preview: ${currentFile.path}`}
        />
      );
    }
    if (isMarkdown) {
      return (
        <div className="h-full overflow-auto bg-background p-4">
          <pre className="whitespace-pre-wrap text-sm font-mono">{currentFile.content || ''}</pre>
        </div>
      );
    }
    // text / code
    return (
      <pre className="h-full overflow-auto bg-background p-4 text-sm font-mono whitespace-pre-wrap">
        {currentFile.content || ''}
      </pre>
    );
  };

  return (
    <Dialog open={!!path} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent layout="viewport" showCloseButton={false} className="flex h-full flex-col gap-0 p-0">
        <DialogTitle className="sr-only">{fileName}</DialogTitle>
        <DialogDescription className="sr-only">File preview: {fileName}</DialogDescription>

        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{fileName}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {currentIndex >= 0 && allPaths.length > 1 && (
                <span>{currentIndex + 1} / {allPaths.length}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {isHtml && (
              <Button variant="ghost" size="icon-sm" onClick={() => setHtmlViewMode((m) => m === 'code' ? 'preview' : 'code')}>
                {htmlViewMode === 'code' ? <Eye className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
              </Button>
            )}
            {isHtml && htmlViewMode === 'preview' && (
              <Button variant="ghost" size="icon-sm" onClick={() => setHtmlRefreshKey((k) => k + 1)}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={() => void downloadFile(displayPath)} aria-label={t('download')}>
              <Download className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          {renderContent()}

          {allPaths.length > 1 && hasPrev && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute left-2 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-background/80 shadow-md hover:bg-background z-10"
              onClick={handlePrev}
              aria-label="Previous file"
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
          )}
          {allPaths.length > 1 && hasNext && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-background/80 shadow-md hover:bg-background z-10"
              onClick={handleNext}
              aria-label="Next file"
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}