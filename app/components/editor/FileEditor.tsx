'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Code2, Download, Eye, FileText, Loader2, RefreshCw, Save, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useFileStore, type FileNode } from '@/app/store/file-store';
import { useEditorStore } from '@/app/store/editor-store';
import { MarkdownEditor } from './MarkdownEditor';
import { ShareMarkdownDialog } from '../file-browser/ShareMarkdownDialog';
import { CodeEditor } from './CodeEditor';
import { HtmlViewer } from './HtmlViewer';
import { ImageViewer } from './ImageViewer';
import { PdfViewer } from './PdfViewer';
import { MediaViewer } from './MediaViewer';
import dynamic from 'next/dynamic';

const OfficeEditor = dynamic(() => import('./OfficeEditor').then(mod => mod.OfficeEditor), {
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
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
]);
const PDF_EXTENSIONS = new Set(['pdf']);
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov']);
const TEXT_EXTENSIONS = new Set([
  'txt',
  'log',
  'js',
  'jsx',
  'ts',
  'tsx',
  'json',
  'css',
  'scss',
  'html',
  'yml',
  'yaml',
  'md',
  'mdx',
  'markdown',
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

const MEDIA_MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
};

function getExtension(path: string) {
  const parts = path.split('.');
  if (parts.length <= 1) return '';
  return parts[parts.length - 1].toLowerCase();
}

function flattenDirectoryImages(nodes: FileNode[], dirPath: string): string[] {
  const isImagePath = (path: string) => IMAGE_EXTENSIONS.has(getExtension(path));

  if (dirPath === '.') {
    return nodes
      .filter((node) => node.type === 'file' && isImagePath(node.path))
      .map((node) => node.path);
  }

  for (const node of nodes) {
    if (node.path === dirPath) {
      return (node.children ?? [])
        .filter((child) => child.type === 'file' && isImagePath(child.path))
        .map((child) => child.path);
    }
    if (node.children) {
      const nestedImages = flattenDirectoryImages(node.children, dirPath);
      if (nestedImages.length > 0) {
        return nestedImages;
      }
    }
  }

  return [];
}

function isTextInputTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable;
}

function formatTimestamp(timestamp: number | null) {
  if (!timestamp) return null;
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function FileEditor() {
  const t = useTranslations('notebook');
  const { currentFile, isLoadingFile, fileError, saveFile, downloadFile, loadFile, fileTree, currentDirectory } = useFileStore();
  const {
    activePath,
    draft,
    isDirty,
    isSaving,
    lastSavedAt,
    saveError,
    setActiveFile,
    updateDraft,
    markSaving,
    markSaved,
    setSaveError,
    clear,
  } = useEditorStore();

  const saveTimeoutRef = useRef<number | null>(null);
  const imagePreviewRef = useRef<HTMLDivElement>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [htmlViewMode, setHtmlViewMode] = useState<'code' | 'preview'>('preview');
  const [htmlRefreshKey, setHtmlRefreshKey] = useState(0);

  useEffect(() => {
    // This effect synchronizes the main file store (useFileStore) 
    // with the editor's local state (useEditorStore).
    if (!currentFile) {
      clear();
      return;
    }

    const editorState = useEditorStore.getState();

    // Case 1: A completely new file is selected.
    if (currentFile.path !== editorState.activePath) {
      setActiveFile(currentFile.path, currentFile.content);
      return;
    }

    // Case 2: The same file is being refreshed from the server.
    // The `currentFile` object is new, but the path is the same.
    // We only want to update the editor's draft if the user doesn't have unsaved changes.
    if (currentFile.path === editorState.activePath && !editorState.isDirty) {
      // If the content from the server is different from the draft, update the editor.
      if (currentFile.content !== editorState.draft) {
        setActiveFile(currentFile.path, currentFile.content);
      }
    }
  }, [currentFile, clear, setActiveFile]);

  useEffect(() => {
    if (!activePath || !isDirty) return;

    if (saveTimeoutRef.current) {
      window.clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(async () => {
      const { activePath: pathToSave, draft: contentToSave } =
        useEditorStore.getState();
      if (!pathToSave) return;

      markSaving();

      try {
        await saveFile(pathToSave, contentToSave);
        const latestState = useEditorStore.getState();
        if (
          latestState.activePath === pathToSave &&
          latestState.draft === contentToSave
        ) {
          markSaved();
        } else {
          setSaveError(null);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t('failedToSaveFile');
        setSaveError(message);
        toast.error(message);
      }
    }, 800);

    return () => {
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [activePath, draft, isDirty, markSaved, markSaving, saveFile, setSaveError, t]);

  const extension = useMemo(() => {
    if (!currentFile) return '';
    return getExtension(currentFile.path);
  }, [currentFile]);

  const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);
  const isHtml = HTML_EXTENSIONS.has(extension);
  const isOffice = OFFICE_EXTENSIONS.has(extension);
  const isImage = IMAGE_EXTENSIONS.has(extension);
  const isPdf = PDF_EXTENSIONS.has(extension);
  const isAudio = AUDIO_EXTENSIONS.has(extension);
  const isVideo = VIDEO_EXTENSIONS.has(extension);
  const isText = extension === '' || TEXT_EXTENSIONS.has(extension);
  const isBinary = !isText && !isImage && !isPdf && !isMarkdown && !isHtml && !isAudio && !isVideo && !isOffice;
  const savedTime = formatTimestamp(lastSavedAt);
  const breadcrumbs = currentFile ? currentFile.path.split('/').filter(Boolean) : [];
  const mediaMimeType = MEDIA_MIME_TYPES[extension];
  const imagePaths = useMemo(
    () => flattenDirectoryImages(fileTree, currentDirectory),
    [currentDirectory, fileTree]
  );
  const imageIndex = currentFile && isImage ? imagePaths.indexOf(currentFile.path) : -1;
  const hasImagePrev = imageIndex > 0;
  const hasImageNext = imageIndex >= 0 && imageIndex < imagePaths.length - 1;

  const handleImagePrev = useCallback(() => {
    if (!hasImagePrev) return;
    void loadFile(imagePaths[imageIndex - 1], true);
  }, [hasImagePrev, imageIndex, imagePaths, loadFile]);

  const handleImageNext = useCallback(() => {
    if (!hasImageNext) return;
    void loadFile(imagePaths[imageIndex + 1], true);
  }, [hasImageNext, imageIndex, imagePaths, loadFile]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        const { activePath: pathToSave, draft: contentToSave } =
          useEditorStore.getState();
        if (!pathToSave) return;
        markSaving();
        saveFile(pathToSave, contentToSave)
          .then(() => {
            const latestState = useEditorStore.getState();
            if (
              latestState.activePath === pathToSave &&
              latestState.draft === contentToSave
            ) {
              markSaved();
            }
          })
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : t('failedToSaveFile');
            setSaveError(message);
            toast.error(message);
          });
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [markSaved, markSaving, saveFile, setSaveError, t]);

  useEffect(() => {
    if (!isImage) return;
    imagePreviewRef.current?.focus({ preventScroll: true });
  }, [currentFile?.path, isImage]);

  useEffect(() => {
    if (!isImage || imagePaths.length <= 1) return;

    const handleImageKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTextInputTarget(event.target)) return;

      const previewElement = imagePreviewRef.current;
      if (!previewElement?.contains(document.activeElement)) return;

      event.preventDefault();
      if (event.key === 'ArrowLeft') {
        handleImagePrev();
      } else {
        handleImageNext();
      }
    };

    window.addEventListener('keydown', handleImageKeyDown);
    return () => window.removeEventListener('keydown', handleImageKeyDown);
  }, [handleImageNext, handleImagePrev, imagePaths.length, isImage]);

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
      </div>
    );
  }

  if (!currentFile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <FileText className="h-6 w-6" />
        <p className="text-sm">{t('selectFileToPreview')}</p>
      </div>
    );
  }

  return (
    <>
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-nowrap items-center justify-between border-b border-border px-3 sm:px-4 py-2 text-sm text-muted-foreground gap-2 overflow-hidden">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2 text-xs text-muted-foreground overflow-hidden">
          <span className="text-foreground shrink-0">{t('fileLabel')}</span>
          <div className="flex min-w-0 items-center overflow-hidden">
            {breadcrumbs.map((segment, index) => (
              <span key={`segment-${segment}-${index}`} className="truncate min-w-0">
                {index > 0 && <span className="mx-0.5 text-muted-foreground/50">/</span>}
                {segment}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
          {isHtml && (
            <>
              {htmlViewMode === 'preview' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => setHtmlRefreshKey((k) => k + 1)}
                  title="Refresh preview"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2"
                onClick={() => setHtmlViewMode((m) => (m === 'code' ? 'preview' : 'code'))}
              >
                {htmlViewMode === 'code' ? (
                  <><Eye className="h-3.5 w-3.5" /><span>Preview</span></>
                ) : (
                  <><Code2 className="h-3.5 w-3.5" /><span>Code</span></>
                )}
              </Button>
            </>
          )}
          {isImage && <span className="bg-muted px-2 py-0.5 text-foreground shrink-0">{t('readOnly')}</span>}
          {isMarkdown && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => setShareOpen(true)}
              title="Export / Share"
            >
              <Share2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {saveError ? (
            <span className="flex items-center gap-1 text-destructive shrink-0" title={saveError}>
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{saveError}</span>
            </span>
          ) : isSaving ? (
            <span className="flex items-center gap-1 shrink-0" title={t('saving')}>
              <Save className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('saving')}</span>
            </span>
          ) : isDirty ? (
            <span className="flex items-center gap-1 shrink-0" title={t('unsavedChanges')}>
              <Save className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('unsavedChanges')}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-primary shrink-0" title={savedTime ? t('savedAt', { time: savedTime }) : t('saved')}>
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{savedTime ? t('savedAt', { time: savedTime }) : t('saved')}</span>
            </span>
          )}
        </div>
      </div>
      <div className={isImage || isVideo || isMarkdown || isHtml ? 'min-h-0 flex-1 overflow-hidden' : (isOffice && extension !== 'docx' ? 'min-h-0 flex-1 relative' : 'min-h-0 flex-1 overflow-auto')}>
          {isBinary ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
              <FileText className="h-8 w-8" />
              <p className="text-sm">{t('binaryPreviewUnavailable')}</p>
              <Button variant="secondary" onClick={() => downloadFile(currentFile.path)}>
                <Download className="h-4 w-4" />
                {t('downloadFile')}
              </Button>
            </div>
          ) : isImage ? (
            <div
              ref={imagePreviewRef}
              tabIndex={0}
              className="relative h-full outline-none"
              aria-label={breadcrumbs[breadcrumbs.length - 1] ?? currentFile.path}
            >
              <ImageViewer path={currentFile.path} />

              {imagePaths.length > 1 && imageIndex >= 0 && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-background/90 shadow-sm backdrop-blur disabled:opacity-40"
                    onClick={handleImagePrev}
                    disabled={!hasImagePrev}
                    aria-label={t('previous')}
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-background/90 shadow-sm backdrop-blur disabled:opacity-40"
                    onClick={handleImageNext}
                    disabled={!hasImageNext}
                    aria-label={t('next')}
                  >
                    <ChevronRight className="h-5 w-5" />
                  </Button>
                </>
              )}
            </div>
          ) : isOffice ? (
            <OfficeEditor 
              key={currentFile.path} 
              path={currentFile.path} 
              extension={extension} 
              updateDraft={updateDraft}
              onChange={() => {}}
            />
          ) : isPdf ? (
            <PdfViewer path={currentFile.path} />
          ) : isAudio ? (
            <MediaViewer
              path={currentFile.path}
              kind="audio"
              mimeType={mediaMimeType}
              size={currentFile.stats?.size}
            />
          ) : isVideo ? (
            <MediaViewer
              path={currentFile.path}
              kind="video"
              mimeType={mediaMimeType}
              size={currentFile.stats?.size}
            />
          ) : isHtml ? (
            <HtmlViewer path={currentFile.path} value={draft} onChange={updateDraft} viewMode={htmlViewMode} refreshKey={htmlRefreshKey} lastSavedAt={lastSavedAt} />
          ) : isMarkdown ? (
            <MarkdownEditor value={draft} onChange={updateDraft} />
          ) : (
            <CodeEditor value={draft} onChange={updateDraft} readOnly={false} />
          )}
      </div>
    </div>
    {isMarkdown && currentFile && (
      <ShareMarkdownDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        filePath={currentFile.path}
        fileName={breadcrumbs[breadcrumbs.length - 1] ?? currentFile.path}
      />
    )}
    </>
  );
}
