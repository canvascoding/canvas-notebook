'use client';

import { useEffect, useMemo, useRef } from 'react';
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

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);
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
    if (!currentFile) {
      clear();
      return;
    }

    if (currentFile.path !== activePath) {
      setActiveFile(currentFile.path, currentFile.content);
    }
  }, [currentFile, activePath, clear, setActiveFile]);

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
          error instanceof Error ? error.message : 'Failed to save file';
        setSaveError(message);
        toast.error(message);
      }
    }, 800);

    return () => {
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [activePath, draft, isDirty, markSaved, markSaving, saveFile, setSaveError]);

  const extension = useMemo(() => {
    if (!currentFile) return '';
    return getExtension(currentFile.path);
  }, [currentFile]);

  const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);
  const isImage = IMAGE_EXTENSIONS.has(extension);
  const isPdf = PDF_EXTENSIONS.has(extension);
  const isAudio = AUDIO_EXTENSIONS.has(extension);
  const isVideo = VIDEO_EXTENSIONS.has(extension);
  const isText = extension === '' || TEXT_EXTENSIONS.has(extension);
  const isBinary = !isText && !isImage && !isPdf && !isMarkdown && !isAudio && !isVideo;
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
              error instanceof Error ? error.message : 'Failed to save file';
            setSaveError(message);
            toast.error(message);
          });
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [markSaved, markSaving, saveFile, setSaveError]);

  if (isLoadingFile) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (fileError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <AlertCircle className="h-6 w-6 text-red-400" />
        <p className="text-sm text-red-300">{fileError}</p>
      </div>
    );
  }

  if (!currentFile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-slate-400">
        <FileText className="h-6 w-6" />
        <p className="text-sm">Select a file to preview.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2 text-sm text-slate-300">
        <div className="flex min-w-0 items-center gap-2 text-xs text-slate-400">
          <span className="text-slate-300">File</span>
          <div className="flex min-w-0 items-center gap-1 truncate">
            {breadcrumbs.map((segment, index) => (
              <span key={`${segment}-${index}`} className="truncate">
                {segment}
                {index < breadcrumbs.length - 1 ? ' / ' : ''}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          {isImage && <span className="rounded bg-slate-800 px-2 py-0.5">Read-only</span>}
          {saveError ? (
            <span className="flex items-center gap-1 text-red-300">
              <AlertCircle className="h-3.5 w-3.5" />
              {saveError}
            </span>
          ) : isSaving ? (
            <span className="flex items-center gap-1">
              <Save className="h-3.5 w-3.5" />
              Saving...
            </span>
          ) : isDirty ? (
            <span className="flex items-center gap-1">
              <Save className="h-3.5 w-3.5" />
              Unsaved changes
            </span>
          ) : (
            <span className="flex items-center gap-1 text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {savedTime ? `Saved ${savedTime}` : 'Saved'}
            </span>
          )}
        </div>
      </div>
      <div className={isVideo ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-auto'}>
          {isBinary ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-slate-400">
              <FileText className="h-8 w-8" />
              <p className="text-sm">Binary file preview is not available.</p>
              <Button variant="secondary" onClick={() => downloadFile(currentFile.path)}>
                <Download className="h-4 w-4" />
                Download file
              </Button>
            </div>
          ) : isImage ? (
            <ImageViewer path={currentFile.path} />
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
