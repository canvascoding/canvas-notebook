'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, Download, FileText, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useFileStore } from '@/app/store/file-store';
import { useEditorStore } from '@/app/store/editor-store';
import { MarkdownEditor } from './MarkdownEditor';
import { CodeEditor } from './CodeEditor';
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

function formatTimestamp(timestamp: number | null) {
  if (!timestamp) return null;
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function FileEditor() {
  const t = useTranslations('notebook');
  const { currentFile, isLoadingFile, fileError, saveFile, downloadFile } = useFileStore();
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
  const isOffice = OFFICE_EXTENSIONS.has(extension);
  const isImage = IMAGE_EXTENSIONS.has(extension);
  const isPdf = PDF_EXTENSIONS.has(extension);
  const isAudio = AUDIO_EXTENSIONS.has(extension);
  const isVideo = VIDEO_EXTENSIONS.has(extension);
  const isText = extension === '' || TEXT_EXTENSIONS.has(extension);
  const isBinary = !isText && !isImage && !isPdf && !isMarkdown && !isAudio && !isVideo && !isOffice;
  const savedTime = formatTimestamp(lastSavedAt);
  const breadcrumbs = currentFile ? currentFile.path.split('/').filter(Boolean) : [];
  const mediaMimeType = MEDIA_MIME_TYPES[extension];

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-nowrap items-center justify-between border-b border-border px-3 sm:px-4 py-2 text-sm text-muted-foreground gap-2">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2 text-xs text-muted-foreground overflow-hidden">
          <span className="text-foreground shrink-0">{t('fileLabel')}</span>
          <div className="flex min-w-0 items-center overflow-hidden">
            {breadcrumbs.map((segment, index) => (
              <span key={`segment-${segment}-${index}`} className="truncate">
                {index > 0 && <span className="mx-0.5 text-muted-foreground/50">/</span>}
                {segment}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
          {isImage && <span className="bg-muted px-2 py-0.5 text-foreground shrink-0">{t('readOnly')}</span>}
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
      <div className={isVideo || isMarkdown ? 'min-h-0 flex-1 overflow-hidden' : (isOffice && extension !== 'docx' ? 'min-h-0 flex-1 relative' : 'min-h-0 flex-1 overflow-auto')}>
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
            <ImageViewer path={currentFile.path} />
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
          ) : isMarkdown ? (
            <MarkdownEditor value={draft} onChange={updateDraft} />
          ) : (
            <CodeEditor value={draft} onChange={updateDraft} readOnly={false} />
          )}
      </div>
    </div>
  );
}
