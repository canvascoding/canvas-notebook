'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Code2, Download, Eye, FileText, Loader2, MoreVertical, Presentation, RefreshCw, Save, Share2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useFileStore, type FileNode } from '@/app/store/file-store';
import { useEditorStore } from '@/app/store/editor-store';
import { getFileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';
import { isMarpMarkdown } from '@/app/lib/marp/detect';
import { MarkdownEditor } from './MarkdownEditor';
import { MarpPreview } from './MarpPreview';
import { ShareMarkdownDialog } from '../file-browser/ShareMarkdownDialog';
import { FileActionsDropdown } from '../file-browser/FileActionsDropdown';
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

const ExcalidrawEditor = dynamic(() => import('./ExcalidrawEditor').then(mod => mod.ExcalidrawEditor), {
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
const EXCALIDRAW_EXTENSIONS = new Set(['excalidraw']);
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
  'excalidraw',
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

const DOCUMENT_SKELETON_EXTENSIONS = new Set([
  'doc',
  'docx',
  'rtf',
  'odt',
  'txt',
  'log',
  'md',
  'mdx',
  'markdown',
  'html',
  'htm',
  'pdf',
]);
const AUTOSAVE_DELAY_MS = 800;
const EXCALIDRAW_AUTOSAVE_DELAY_MS = 3000;
const EXTERNAL_FILE_RELOAD_DELAY_MS = 250;

function getExtension(path: string) {
  const parts = path.split('.');
  if (parts.length <= 1) return '';
  return parts[parts.length - 1].toLowerCase();
}

function normalizeWorkspaceRelativePath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function fileEventMatchesPath(event: FileEvent, filePath: string) {
  const normalizedFilePath = normalizeWorkspaceRelativePath(filePath);
  const normalizedRelativePath = normalizeWorkspaceRelativePath(event.relativePath);

  if (normalizedRelativePath === normalizedFilePath) {
    return true;
  }

  return event.path.replace(/\\/g, '/').endsWith(`/${normalizedFilePath}`);
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

function shouldShowDocumentLoadingSkeleton(path: string | null) {
  if (!path) return true;
  const extension = getExtension(path);
  return extension === '' || TEXT_EXTENSIONS.has(extension) || DOCUMENT_SKELETON_EXTENSIONS.has(extension);
}

function shouldShowImageLoadingSkeleton(path: string | null) {
  if (!path) return false;
  return IMAGE_EXTENSIONS.has(getExtension(path));
}

function FileLoadingSkeleton({ path }: { path: string | null }) {
  const t = useTranslations('notebook');
  const fileName = path?.split('/').filter(Boolean).pop() || t('loadingPreview');

  return (
    <div data-testid="file-loading-skeleton" className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="h-4 w-10 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-foreground">{fileName}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{t('loadingPreview')}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-6 w-6" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <div className="mx-auto flex h-full max-w-3xl flex-col gap-5">
          <div className="space-y-3">
            <Skeleton className="h-7 w-3/5" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[92%]" />
              <Skeleton className="h-4 w-[96%]" />
              <Skeleton className="h-4 w-[84%]" />
            </div>
            <Skeleton className="hidden h-24 sm:block" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-[88%]" />
            <Skeleton className="h-4 w-[94%]" />
            <Skeleton className="h-4 w-[76%]" />
          </div>
          <div className="mt-auto grid grid-cols-3 gap-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ImageLoadingSkeleton({ path }: { path: string | null }) {
  const t = useTranslations('notebook');
  const fileName = path?.split('/').filter(Boolean).pop() || t('loadingPreview');

  return (
    <div data-testid="image-loading-skeleton" className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="h-4 w-10 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-foreground">{fileName}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{t('loadingPreview')}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-6 w-6" />
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background p-4">
        <div className="flex h-full items-center justify-center">
          <div className="relative flex h-full w-full max-w-5xl items-center justify-center">
            <Skeleton className="h-full max-h-[620px] min-h-40 w-full rounded-lg" />
            <div className="pointer-events-none absolute inset-x-4 bottom-4 flex justify-center gap-2">
              <Skeleton className="h-2 w-16 rounded-full bg-background/70" />
              <Skeleton className="h-2 w-10 rounded-full bg-background/70" />
              <Skeleton className="h-2 w-14 rounded-full bg-background/70" />
            </div>
          </div>
        </div>
        <Skeleton className="absolute left-3 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full" />
        <Skeleton className="absolute right-3 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full" />
      </div>
    </div>
  );
}

interface FileEditorProps {
  onClosePreview?: () => void;
}

type HtmlViewMode = 'code' | 'preview';

export function FileEditor({ onClosePreview }: FileEditorProps = {}) {
  const t = useTranslations('notebook');
  const {
    currentFile,
    isLoadingFile,
    loadingFilePath,
    fileError,
    saveFile,
    downloadFile,
    loadFile,
    refreshCurrentFileContent,
    fileTree,
    currentDirectory,
  } = useFileStore();
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
  const externalReloadTimeoutRef = useRef<number | null>(null);
  const imagePreviewRef = useRef<HTMLDivElement>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [htmlViewPreference, setHtmlViewPreference] = useState<{ path: string | null; mode: HtmlViewMode }>({
    path: null,
    mode: 'preview',
  });
  const [htmlRefreshKey, setHtmlRefreshKey] = useState(0);
  const [markdownViewOverride, setMarkdownViewOverride] = useState<{
    path: string | null;
    mode: 'markdown' | 'slides';
  }>({ path: null, mode: 'markdown' });
  const [marpRefreshKey, setMarpRefreshKey] = useState(0);
  const [isClosingPreview, setIsClosingPreview] = useState(false);

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

    const autosaveDelay = getExtension(activePath) === 'excalidraw'
      ? EXCALIDRAW_AUTOSAVE_DELAY_MS
      : AUTOSAVE_DELAY_MS;

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
    }, autosaveDelay);

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
  const isMarpMarkdownFile = currentFile ? isMarkdown && isMarpMarkdown(currentFile.path, draft) : false;
  const isHtml = HTML_EXTENSIONS.has(extension);
  const isOffice = OFFICE_EXTENSIONS.has(extension);
  const isExcalidraw = EXCALIDRAW_EXTENSIONS.has(extension);
  const isImage = IMAGE_EXTENSIONS.has(extension);
  const isPdf = PDF_EXTENSIONS.has(extension);
  const isAudio = AUDIO_EXTENSIONS.has(extension);
  const isVideo = VIDEO_EXTENSIONS.has(extension);
  const isText = extension === '' || TEXT_EXTENSIONS.has(extension);
  const isBinary = !isText && !isImage && !isPdf && !isMarkdown && !isHtml && !isExcalidraw && !isAudio && !isVideo && !isOffice;
  const markdownViewMode = isMarpMarkdownFile
    ? (markdownViewOverride.path === activePath ? markdownViewOverride.mode : 'slides')
    : 'markdown';
  const htmlViewMode: HtmlViewMode = isHtml && htmlViewPreference.path === currentFile?.path
    ? htmlViewPreference.mode
    : 'preview';

  const setCurrentHtmlViewMode = useCallback((nextMode: HtmlViewMode | ((mode: HtmlViewMode) => HtmlViewMode)) => {
    const htmlPath = currentFile?.path ?? null;
    setHtmlViewPreference((previous) => {
      const currentMode = previous.path === htmlPath ? previous.mode : 'preview';
      return {
        path: htmlPath,
        mode: typeof nextMode === 'function' ? nextMode(currentMode) : nextMode,
      };
    });
  }, [currentFile?.path]);

  const savedTime = formatTimestamp(lastSavedAt);
  const breadcrumbs = currentFile ? currentFile.path.split('/').filter(Boolean) : [];
  const currentFileNode = useMemo<FileNode | null>(() => {
    if (!currentFile) return null;

    return {
      name: currentFile.path.split('/').pop() || currentFile.path,
      path: currentFile.path,
      type: 'file',
      size: currentFile.stats?.size,
      modified: currentFile.stats?.modified,
      permissions: currentFile.stats?.permissions,
    };
  }, [currentFile]);
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

  const handleShareAction = useCallback(() => {
    if (!currentFile) return;

    if (isPdf) {
      void downloadFile(currentFile.path);
      return;
    }

    setShareOpen(true);
  }, [currentFile, downloadFile, isPdf]);

  const handleClosePreview = useCallback(async () => {
    if (isClosingPreview) return;

    const {
      activePath: pathToSave,
      draft: contentToSave,
      isDirty: hasUnsavedChanges,
    } = useEditorStore.getState();

    setIsClosingPreview(true);

    try {
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      if (pathToSave && hasUnsavedChanges) {
        markSaving();
        await saveFile(pathToSave, contentToSave);
        const latestState = useEditorStore.getState();
        if (
          latestState.activePath === pathToSave &&
          latestState.draft === contentToSave
        ) {
          markSaved();
        }
      }

      onClosePreview?.();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t('failedToSaveFile');
      setSaveError(message);
      toast.error(message);
    } finally {
      setIsClosingPreview(false);
    }
  }, [isClosingPreview, markSaved, markSaving, onClosePreview, saveFile, setSaveError, t]);

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

  useEffect(() => {
    if (!currentFile?.path || !isExcalidraw) return;

    const watchedFilePath = currentFile.path;
    const client = getFileWatcherClient();
    client.acquire();

    const handleFileChange = (event: Event) => {
      const detail = (event as CustomEvent<FileEvent>).detail;
      if (!detail) return;
      if (detail.type !== 'add' && detail.type !== 'change') return;
      if (!fileEventMatchesPath(detail, watchedFilePath)) return;

      const editorState = useEditorStore.getState();
      if (editorState.activePath !== watchedFilePath || editorState.isDirty) return;

      if (externalReloadTimeoutRef.current) {
        window.clearTimeout(externalReloadTimeoutRef.current);
      }

      externalReloadTimeoutRef.current = window.setTimeout(() => {
        externalReloadTimeoutRef.current = null;
        const latestEditorState = useEditorStore.getState();
        if (latestEditorState.activePath !== watchedFilePath || latestEditorState.isDirty) return;

        void refreshCurrentFileContent(watchedFilePath);
      }, EXTERNAL_FILE_RELOAD_DELAY_MS);
    };

    client.addEventListener('filechange', handleFileChange);

    return () => {
      client.removeEventListener('filechange', handleFileChange);
      client.releaseConnection();
      if (externalReloadTimeoutRef.current) {
        window.clearTimeout(externalReloadTimeoutRef.current);
        externalReloadTimeoutRef.current = null;
      }
    };
  }, [currentFile?.path, isExcalidraw, refreshCurrentFileContent]);

  if (isLoadingFile) {
    const pendingPath = loadingFilePath ?? currentFile?.path ?? null;
    if (shouldShowImageLoadingSkeleton(pendingPath)) {
      return <ImageLoadingSkeleton path={pendingPath} />;
    }

    if (shouldShowDocumentLoadingSkeleton(pendingPath)) {
      return <FileLoadingSkeleton path={pendingPath} />;
    }

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
                onClick={() => setCurrentHtmlViewMode((m) => (m === 'code' ? 'preview' : 'code'))}
              >
                {htmlViewMode === 'code' ? (
                  <><Eye className="h-3.5 w-3.5" /><span>Preview</span></>
                ) : (
                  <><Code2 className="h-3.5 w-3.5" /><span>Code</span></>
                )}
              </Button>
            </>
          )}
          {isMarpMarkdownFile && (
            <>
              {markdownViewMode === 'slides' && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => setMarpRefreshKey((key) => key + 1)}
                  title={t('refreshPreview')}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2"
                onClick={() => {
                  setMarkdownViewOverride({
                    path: activePath,
                    mode: markdownViewMode === 'markdown' ? 'slides' : 'markdown',
                  });
                }}
              >
                {markdownViewMode === 'markdown' ? (
                  <><Presentation className="h-3.5 w-3.5" /><span>{t('slidesPreview')}</span></>
                ) : (
                  <><Code2 className="h-3.5 w-3.5" /><span>{t('markdownEditor')}</span></>
                )}
              </Button>
            </>
          )}
          {isImage && <span className="bg-muted px-2 py-0.5 text-foreground shrink-0">{t('readOnly')}</span>}
          {(isMarkdown || isHtml || isPdf) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 gap-1.5 text-xs"
              onClick={handleShareAction}
              title={isPdf ? t('downloadPdf') : t('share')}
            >
              <Share2 className="h-3.5 w-3.5" />
              <span>{t('share')}</span>
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
          <FileActionsDropdown
            node={currentFileNode}
            showCreateActions={false}
            showMultiSelectActions={false}
            onAfterDelete={() => onClosePreview?.()}
            contentProps={{ align: 'end' }}
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              aria-label={t('fileActions')}
              title={t('fileActions')}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </FileActionsDropdown>
          {onClosePreview ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => void handleClosePreview()}
              disabled={isClosingPreview}
              aria-label="Close preview"
              title="Close preview"
            >
              {isClosingPreview ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
            </Button>
          ) : null}
        </div>
      </div>
      <div className={isImage || isVideo || isMarkdown || isHtml || isExcalidraw ? 'min-h-0 flex-1 overflow-hidden' : (isOffice && extension !== 'docx' ? 'min-h-0 flex-1 relative' : 'min-h-0 flex-1 overflow-auto')}>
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
            <PdfViewer key={currentFile.path} path={currentFile.path} />
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
          ) : isExcalidraw ? (
            <ExcalidrawEditor path={currentFile.path} value={draft} onChange={updateDraft} />
          ) : isMarkdown ? (
            isMarpMarkdownFile && markdownViewMode === 'slides' ? (
              <MarpPreview path={currentFile.path} content={draft} refreshKey={marpRefreshKey} />
            ) : (
              <MarkdownEditor value={draft} onChange={updateDraft} filePath={currentFile.path} />
            )
          ) : (
            <CodeEditor value={draft} onChange={updateDraft} readOnly={false} />
          )}
      </div>
    </div>
    {(isMarkdown || isHtml) && currentFile && (
      <ShareMarkdownDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        filePath={currentFile.path}
        fileName={breadcrumbs[breadcrumbs.length - 1] ?? currentFile.path}
        kind={isHtml ? 'html' : 'markdown'}
      />
    )}
    </>
  );
}
