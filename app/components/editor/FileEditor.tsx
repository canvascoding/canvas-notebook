'use client';

import { documentCapabilities, TEXT_FILE_EXTENSIONS as TEXT_EXTENSIONS, withDocumentRevision } from '@/app/lib/files/document-capabilities';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { workspaceDownloadUrl } from '@/app/lib/files/client';
import { useLiveMarkdown } from './MarkdownDocumentModes';
import { useExcalidrawCollaboration } from '@/app/lib/excalidraw-collaboration/client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, ChevronLeft, ChevronRight, Code2, Download, Eye, FileText, GitBranch, Info, Loader2, Lock, MoreVertical, Presentation, RefreshCw, Share2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useFileStore } from '@/app/store/file-store';
import type { CurrentFile, FileNode } from '@/app/lib/files/types';
import {
  isWorkspaceFileRevisionConflictError,
  readWorkspaceFile,
} from '@/app/lib/files/client';
import { LocalFileWriteTracker } from '@/app/lib/files/local-write-tracker';
import { useEditorStore } from '@/app/store/editor-store';
import { getDocumentTransitionGuard, registerDocumentTransitionGuard } from '@/app/lib/files/document-transition';
import { prepareCollaborationDocumentTransition, useTextCollaborationSession, useCollaborationDocument } from '@/app/lib/collaboration/client';
import {
  CollaborationCheckpointRequestError,
  isCollaborationCheckpointValidationErrorCode,
} from '@/app/lib/collaboration/checkpoint-errors';
import type { CollaborationAgentOperation } from '@/app/lib/collaboration/agent-operations-client';
import { visibleAgentTargetAnchors } from '@/app/lib/collaboration/agent-target-decorations';
import { isMarpMarkdown } from '@/app/lib/marp/detect';
import { MarkdownEditor } from './MarkdownEditorClient';
import { MarpPreview } from './MarpPreview';
import { MarpExportDialog } from '../file-browser/MarpExportDialog';
import { ShareMarkdownDialog } from '../file-browser/ShareMarkdownDialog';
import { FileActionsDropdown } from '../file-browser/FileActionsDropdown';
import { CodeEditor } from './CodeEditorClient';
import { CollaborationAgentOperations } from './CollaborationAgentOperations';
import { HtmlViewer } from './HtmlViewer';
import { ImageViewer } from './ImageViewer';
import { PdfViewer } from './PdfViewer';
import { MediaViewer } from './MediaViewer';
import { EditorErrorBoundary } from './EditorErrorBoundary';
import type { OfficeEditorRef } from './OfficeEditor';
import dynamic from 'next/dynamic';
import { useShallow } from 'zustand/react/shallow';

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

function isFileRevisionConflictMessage(message: string) {
  return message.toLowerCase().includes('file revision conflict');
}

interface ExternalTextChange {
  path: string;
  baseContent: string;
  serverFile: CurrentFile;
  detectedAt: number;
  source: 'watch' | 'save-conflict';
}

type TextMergeResult =
  | { clean: true; content: string }
  | { clean: false };

function splitTextLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/gu) ?? [];
}

function findSingleChangedRange(baseLines: string[], nextLines: string[]) {
  let prefix = 0;
  while (
    prefix < baseLines.length &&
    prefix < nextLines.length &&
    baseLines[prefix] === nextLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < baseLines.length - prefix &&
    suffix < nextLines.length - prefix &&
    baseLines[baseLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    baseStart: prefix,
    baseEnd: baseLines.length - suffix,
    nextLines: nextLines.slice(prefix, nextLines.length - suffix),
  };
}

function rangesOverlap(
  left: { baseStart: number; baseEnd: number },
  right: { baseStart: number; baseEnd: number },
) {
  return left.baseStart < right.baseEnd && right.baseStart < left.baseEnd;
}

function mergeTextChanges(baseContent: string, localContent: string, serverContent: string): TextMergeResult {
  if (localContent === serverContent) return { clean: true, content: localContent };
  if (baseContent === localContent) return { clean: true, content: serverContent };
  if (baseContent === serverContent) return { clean: true, content: localContent };

  const baseLines = splitTextLines(baseContent);
  const localLines = splitTextLines(localContent);
  const serverLines = splitTextLines(serverContent);
  const localChange = findSingleChangedRange(baseLines, localLines);
  const serverChange = findSingleChangedRange(baseLines, serverLines);
  const bothInsertAtSamePosition =
    localChange.baseStart === localChange.baseEnd &&
    serverChange.baseStart === serverChange.baseEnd &&
    localChange.baseStart === serverChange.baseStart &&
    localChange.nextLines.length > 0 &&
    serverChange.nextLines.length > 0;

  if (bothInsertAtSamePosition || rangesOverlap(localChange, serverChange)) {
    return { clean: false };
  }

  const mergedLines = [...baseLines];
  const changes = [localChange, serverChange].sort((a, b) => b.baseStart - a.baseStart);
  for (const change of changes) {
    mergedLines.splice(change.baseStart, change.baseEnd - change.baseStart, ...change.nextLines);
  }

  return { clean: true, content: mergedLines.join('') };
}

function buildConflictCopyPath(filePath: string) {
  const slashIndex = filePath.lastIndexOf('/');
  const dir = slashIndex >= 0 ? filePath.slice(0, slashIndex + 1) : '';
  const fileName = slashIndex >= 0 ? filePath.slice(slashIndex + 1) : filePath;
  const dotIndex = fileName.lastIndexOf('.');
  const stamp = `${new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${Date.now().toString(36)}`;
  if (dotIndex <= 0) return `${dir}${fileName}.local-copy-${stamp}`;
  return `${dir}${fileName.slice(0, dotIndex)}.local-copy-${stamp}${fileName.slice(dotIndex)}`;
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

function FileHeaderTooltip({ children, label }: { children: ReactElement; label: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
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

class SupersededEditorOperation extends Error {}

function captureEditorScope() {
  const editorSessionId = useEditorStore.getState().sessionId;
  const { currentFileWorkspaceId: workspaceId, treeGeneration } = useFileStore.getState();
  return () => useEditorStore.getState().sessionId === editorSessionId
    && useFileStore.getState().currentFileWorkspaceId === workspaceId
    && useFileStore.getState().treeGeneration === treeGeneration;
}

type HtmlViewMode = 'code' | 'preview';

export function FileEditor({ onClosePreview }: FileEditorProps = {}) {
  const t = useTranslations('notebook');
  const {
    currentFile,
    currentFileWorkspaceId,
    pendingExternalFile,
    documentSyncStatus,
    isLoadingFile,
    loadingFilePath,
    fileError,
    fileErrorPath,
    missingFilePath,
    saveFile,
    downloadFile,
    loadFile,
    revealAndLoadFile,
    refreshCurrentFileContent,
    fileTree,
    currentDirectory,
  } = useFileStore(useShallow((state) => ({
    currentFile: state.currentFile,
    currentFileWorkspaceId: state.currentFileWorkspaceId,
    pendingExternalFile: state.pendingExternalFile,
    documentSyncStatus: state.documentSyncStatus,
    isLoadingFile: state.isLoadingFile,
    loadingFilePath: state.loadingFilePath,
    fileError: state.fileError,
    fileErrorPath: state.fileErrorPath,
    missingFilePath: state.missingFilePath,
    saveFile: state.saveFile,
    downloadFile: state.downloadFile,
    loadFile: state.loadFile,
    revealAndLoadFile: state.revealAndLoadFile,
    refreshCurrentFileContent: state.refreshCurrentFileContent,
    fileTree: state.fileTree,
    currentDirectory: state.currentDirectory,
  })));
  const {
    activePath,
    draft,
    isDirty,
    isSaving,
    lastSavedAt,
    saveError,
    setActiveFile,
    updateDraft,
    syncCollaborativeDraft,
    markSaving,
    markSaved,
    setSaveError,
    clear,
  } = useEditorStore();

  const saveTimeoutRef = useRef<number | null>(null);
  const officeEditorRef = useRef<OfficeEditorRef>(null);
  const localWriteTrackerRef = useRef(new LocalFileWriteTracker());
  const imagePreviewRef = useRef<HTMLDivElement>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [marpExportOpen, setMarpExportOpen] = useState(false);
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
  const [officeReloadKey, setOfficeReloadKey] = useState(0);
  const [localExternalTextChange, setExternalTextChange] = useState<ExternalTextChange | null>(null);
  const [isResolvingExternalTextChange, setIsResolvingExternalTextChange] = useState(false);
  const currentFilePath = currentFile?.path ?? null;
  const documentIdentity = `${currentFileWorkspaceId}:${currentFile?.viewId ?? currentFile?.collaboration?.document?.id ?? currentFilePath}`;

  const sceneDocument = useExcalidrawCollaboration({ enabled: Boolean(currentFile?.collaboration?.sceneCapable),
    workspaceId: currentFileWorkspaceId, path: currentFilePath ?? '', documentId: currentFile?.collaboration?.document?.id });
  const textSession = useTextCollaborationSession({ enabled: Boolean(currentFile?.collaboration?.crdtCapable),
    workspaceId: currentFileWorkspaceId, path: currentFilePath ?? undefined,
    documentId: currentFile?.collaboration?.document?.id });
  const activeCollaborationDocument = useCollaborationDocument({
    enabled: Boolean(currentFile?.collaboration?.crdtCapable && textSession.session),
    workspaceId: currentFileWorkspaceId, path: currentFilePath ?? undefined,
    representation: textSession.session?.representation === 'plain_text' ? 'plain_text' : 'tiptap_xml',
    session: textSession.session,
  });
  const liveDocument = useLiveMarkdown(activeCollaborationDocument, currentFile?.content ?? '');
  useEffect(() => {
    if (activeCollaborationDocument?.ready && liveDocument.available
      && useEditorStore.getState().activePath === currentFilePath) syncCollaborativeDraft(liveDocument.content);
  }, [activeCollaborationDocument?.ready, currentFilePath, liveDocument, syncCollaborativeDraft]);
  const externalTextChange: ExternalTextChange | null = pendingExternalFile ? {
    path: pendingExternalFile.path, baseContent: useEditorStore.getState().baseContent,
    serverFile: pendingExternalFile, detectedAt: 0, source: 'watch',
  } : localExternalTextChange;
  const [agentOperationState, setAgentOperationState] = useState<{
    documentId: string;
    operations: CollaborationAgentOperation[];
  } | null>(null);
  const activeExternalTextChange = externalTextChange &&
    externalTextChange.path === activePath &&
    externalTextChange.path === currentFilePath
    ? externalTextChange
    : null;
  const activeExternalTextChangePath = activeExternalTextChange?.path ?? null;
  const getSaveErrorMessage = useCallback((error: unknown) => {
    if (error instanceof CollaborationCheckpointRequestError) {
      return isCollaborationCheckpointValidationErrorCode(error.code)
        ? t('collaboration.checkpointValidationFailed')
        : t('collaboration.checkpointFailed');
    }
    const rawMessage =
      error instanceof Error ? error.message : t('failedToSaveFile');
    return isWorkspaceFileRevisionConflictError(error) || isFileRevisionConflictMessage(rawMessage)
      ? t('fileRevisionConflict')
      : rawMessage;
  }, [t]);

  const loadExternalTextChange = useCallback(async (
    path: string,
    source: ExternalTextChange['source'],
  ) => {
    const editorState = useEditorStore.getState();
    if (editorState.activePath !== path) return null;

    const isCurrent = captureEditorScope();
    const serverFile = await readWorkspaceFile(path, {
      workspaceId: currentFileWorkspaceId,
      noCache: true,
      fallbackMessage: 'Failed to refresh file',
    });

    const latestEditorState = useEditorStore.getState();
    if (!isCurrent() || latestEditorState.activePath !== path) return null;

    if (
      source === 'watch' &&
      localWriteTrackerRef.current.consumeMatchingWrite(path, serverFile.content)
    ) {
      return serverFile;
    }

    if (serverFile.content === latestEditorState.draft) {
      setExternalTextChange((current) => current?.path === path ? null : current);
      return serverFile;
    }

    setExternalTextChange({
      path,
      baseContent: latestEditorState.baseContent,
      serverFile,
      detectedAt: Date.now(),
      source,
    });
    return serverFile;
  }, [currentFileWorkspaceId]);

  const saveTrackedFile = useCallback(async (path: string, content: string) => {
    const isCurrent = captureEditorScope();
    localWriteTrackerRef.current.record(path, content);
    try {
      await saveFile(path, content, currentFileWorkspaceId);
      if (!isCurrent()) throw new SupersededEditorOperation();
    } catch (error) {
      localWriteTrackerRef.current.discard(path, content);
      if (!isCurrent()) throw new SupersededEditorOperation();
      throw error;
    }
  }, [currentFileWorkspaceId, saveFile]);

  const handleSaveError = useCallback((error: unknown, path: string) => {
    if (error instanceof SupersededEditorOperation) return;
    const message = getSaveErrorMessage(error);
    setSaveError(message);
    toast.error(message);

    if (isWorkspaceFileRevisionConflictError(error)) {
      void loadExternalTextChange(path, 'save-conflict').catch((loadError) => {
        console.warn('[FileEditor] Failed to load external file change after save conflict:', loadError);
      });
    }
  }, [getSaveErrorMessage, loadExternalTextChange, setSaveError]);

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
    if (
      currentFile.path === editorState.activePath
      && !editorState.isDirty
      && !currentFile.collaboration?.crdtCapable
      && !currentFile.collaboration?.sceneCapable
    ) {
      // If the content from the server is different from the draft, update the editor.
      if (currentFile.content !== editorState.draft) {
        setActiveFile(currentFile.path, currentFile.content);
      }
    }
  }, [currentFile, clear, setActiveFile]);

  useEffect(() => {
    if (currentFile?.collaboration?.crdtCapable || currentFile?.collaboration?.sceneCapable) {
      if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
      return;
    }
    if (!activePath || !isDirty || currentFile?.unavailable) return;
    if (activeExternalTextChangePath) return;

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
        await saveTrackedFile(pathToSave, contentToSave);
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
        handleSaveError(error, pathToSave);
      }
    }, autosaveDelay);

    return () => {
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [activeExternalTextChangePath, activePath, currentFile?.unavailable, currentFile?.collaboration?.crdtCapable, currentFile?.collaboration?.sceneCapable, draft, handleSaveError, isDirty, markSaved, markSaving, saveTrackedFile, setSaveError]);

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
  const editorKind = isMarkdown
    ? 'markdown'
    : isOffice
      ? 'office'
      : isExcalidraw
        ? 'excalidraw'
        : isHtml
          ? 'html'
          : isPdf
            ? 'pdf'
            : isImage
              ? 'image'
              : isAudio
                ? 'audio'
                : isVideo
                  ? 'video'
                  : isBinary
                    ? 'binary'
                    : 'code';
  const collaboration = currentFile?.collaboration ?? null;
  const collaborationDocumentId = collaboration?.crdtCapable ? collaboration.document?.id ?? null : null;
  const agentTargets = useMemo(() => visibleAgentTargetAnchors(
    agentOperationState?.documentId === collaborationDocumentId
      ? agentOperationState.operations
      : [],
  ), [agentOperationState, collaborationDocumentId]);
  const handleAgentOperationsChange = useCallback((operations: CollaborationAgentOperation[]) => {
    if (!collaborationDocumentId) return;
    setAgentOperationState({ documentId: collaborationDocumentId, operations });
  }, [collaborationDocumentId]);
  const isSceneCollaboration = Boolean(collaboration?.sceneCapable);
  const isCrdtCollaboration = Boolean(collaboration?.crdtCapable);
  const updateCollaborativeDraft = useCallback((value: string) => {
    if (isCrdtCollaboration) {
      syncCollaborativeDraft(value);
      return;
    }
    updateDraft(value);
  }, [isCrdtCollaboration, syncCollaborativeDraft, updateDraft]);
  const collaborationLabel = useMemo(() => {
    if (!collaboration) return null;
    if (collaboration.activeLock) return t('collaboration.locked');
    if (collaboration.strategy === 'exclusive_lock') return t('collaboration.lockRequired');
    return null;
  }, [collaboration, t]);
  const markdownViewMode = isMarpMarkdownFile
    ? (markdownViewOverride.path === documentIdentity ? markdownViewOverride.mode : 'slides')
    : 'markdown';
  const htmlViewMode: HtmlViewMode = isHtml && htmlViewPreference.path === documentIdentity
    ? htmlViewPreference.mode
    : 'preview';
  const displayFileError = fileError && !currentFile
    ? fileError
    : null;
  const backgroundFileError = fileError && currentFile
    ? fileError
    : null;

  const setCurrentHtmlViewMode = useCallback((nextMode: HtmlViewMode | ((mode: HtmlViewMode) => HtmlViewMode)) => {
    const htmlPath = documentIdentity;
    setHtmlViewPreference((previous) => {
      const currentMode = previous.path === htmlPath ? previous.mode : 'preview';
      return {
        path: htmlPath,
        mode: typeof nextMode === 'function' ? nextMode(currentMode) : nextMode,
      };
    });
  }, [documentIdentity]);

  const displaySaveError = isCrdtCollaboration
    ? activeCollaborationDocument?.error ?? null
    : saveError ?? null;
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
  const documentRevision = currentFile?.stats?.sha256 ?? currentFile?.revision?.id ?? String(currentFile?.stats?.modified ?? '');
  const mediaSource = withDocumentRevision(toMediaUrl(currentFilePath ?? '', { workspaceId: currentFileWorkspaceId }), documentRevision);
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

    if (isMarpMarkdownFile) {
      setMarpExportOpen(true);
      return;
    }

    setShareOpen(true);
  }, [currentFile, downloadFile, isMarpMarkdownFile, isPdf]);

  const handleReloadExternalTextChange = useCallback(async () => {
    const change = activeExternalTextChange;
    if (!change) return;

    const isCurrent = captureEditorScope();
    setIsResolvingExternalTextChange(true);
    try {
      const refreshed = await refreshCurrentFileContent(change.path, { allowDirty: true });
      if (!isCurrent()) return;
      if (!refreshed) {
        throw new Error(t('externalChangeLoadFailed'));
      }

      setActiveFile(change.path, refreshed.content);
      if (documentCapabilities(change.path).office) setOfficeReloadKey((value) => value + 1);
      setExternalTextChange(null);
      setSaveError(null);
      toast.success(t('externalChangeReloaded'));
    } catch (error) {
      if (!isCurrent() || error instanceof SupersededEditorOperation) return;
      const message = error instanceof Error ? error.message : t('externalChangeLoadFailed');
      setSaveError(message);
      toast.error(message);
    } finally {
      setIsResolvingExternalTextChange(false);
    }
  }, [activeExternalTextChange, refreshCurrentFileContent, setActiveFile, setSaveError, t]);

  const handleMergeExternalTextChange = useCallback(async () => {
    const change = activeExternalTextChange;
    if (!change) return;

    const isCurrent = captureEditorScope();
    setIsResolvingExternalTextChange(true);
    try {
      const refreshed = await refreshCurrentFileContent(change.path, { allowDirty: true });
      if (!isCurrent()) return;
      if (!refreshed) {
        throw new Error(t('externalChangeLoadFailed'));
      }

      const latestEditorState = useEditorStore.getState();
      const merged = mergeTextChanges(change.baseContent, latestEditorState.draft, refreshed.content);
      if (!merged.clean) {
        setExternalTextChange({ ...change, serverFile: refreshed, detectedAt: Date.now() });
        const message = t('externalChangeMergeConflict');
        setSaveError(message);
        toast.error(message);
        return;
      }

      if (merged.content === refreshed.content) {
        setActiveFile(change.path, refreshed.content);
        setExternalTextChange(null);
        setSaveError(null);
        toast.success(t('externalChangeReloaded'));
        return;
      }

      updateDraft(merged.content);
      markSaving();
      await saveTrackedFile(change.path, merged.content);

      const savedState = useEditorStore.getState();
      if (savedState.activePath === change.path && savedState.draft === merged.content) {
        markSaved();
      }

      setExternalTextChange(null);
      toast.success(t('externalChangeMerged'));
    } catch (error) {
      if (!isCurrent() || error instanceof SupersededEditorOperation) return;
      handleSaveError(error, change.path);
    } finally {
      setIsResolvingExternalTextChange(false);
    }
  }, [
    activeExternalTextChange,
    handleSaveError,
    markSaved,
    markSaving,
    refreshCurrentFileContent,
    saveTrackedFile,
    setActiveFile,
    setSaveError,
    t,
    updateDraft,
  ]);

  const handleSaveExternalTextCopy = useCallback(async () => {
    const change = activeExternalTextChange;
    if (!change) return;

    const isCurrent = captureEditorScope();
    setIsResolvingExternalTextChange(true);
    try {
      const latestEditorState = useEditorStore.getState();
      const copyPath = buildConflictCopyPath(change.path);
      const content = documentCapabilities(change.path).office ? await officeEditorRef.current?.save() : latestEditorState.draft;
      if (content == null) throw new Error(t('failedToSaveFile'));
      await saveTrackedFile(copyPath, content);
      if (!isCurrent()) return;
      // Keep the source conflict visible: the copy does not overwrite or resolve it.
      toast.success(t('externalChangeCopySaved'));
    } catch (error) {
      if (!isCurrent() || error instanceof SupersededEditorOperation) return;
      const message = error instanceof Error ? error.message : t('failedToSaveFile');
      setSaveError(message);
      toast.error(message);
    } finally {
      setIsResolvingExternalTextChange(false);
    }
  }, [activeExternalTextChange, saveTrackedFile, setSaveError, t]);

  useEffect(() => {
    if (!currentFilePath || isSceneCollaboration) return;
    return registerDocumentTransitionGuard(currentFileWorkspaceId, currentFilePath, {
      hasPendingChanges: () => useEditorStore.getState().isDirty || Boolean(officeEditorRef.current?.hasChanges()) || Boolean(
        isCrdtCollaboration && activeCollaborationDocument?.durability !== 'checkpointed_file',
      ),
      prepare: async () => {
        if (activeExternalTextChangePath === currentFilePath) {
          throw new Error(t('externalChangeSaveBlocked'));
        }
        if (isOffice && officeEditorRef.current?.hasChanges()) {
          const version = officeEditorRef.current.changeVersion();
          const content = await officeEditorRef.current.save();
          if (content == null) throw new Error(t('failedToSaveFile'));
          await saveTrackedFile(currentFilePath, content);
          if (officeEditorRef.current?.changeVersion() !== version) throw new Error(t('externalChangeSaveBlocked'));
          officeEditorRef.current.markSaved(version);
          return;
        }
        if (!isCrdtCollaboration) return;
        if (!activeCollaborationDocument) throw new Error(t('collaboration.connecting'));
        try { await prepareCollaborationDocumentTransition(activeCollaborationDocument); }
        catch { throw new Error(t('collaboration.closeRecoveryBlocked')); }
      },
    });
  }, [activeCollaborationDocument, activeExternalTextChangePath, currentFilePath,
    isCrdtCollaboration, isSceneCollaboration, isOffice, saveTrackedFile, currentFileWorkspaceId, t]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const { currentFile: file, currentFileWorkspaceId: workspaceId } = useFileStore.getState();
      if (useEditorStore.getState().isDirty
        || (file && getDocumentTransitionGuard(workspaceId, file.path)?.hasPendingChanges())) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  const handleClosePreview = useCallback(() => {
    // The owner handles the same guarded close used by tabs and workspace changes.
    onClosePreview?.();
  }, [onClosePreview]);

  const downloadLocalRecovery = async () => {
    if (!currentFile) return;
    try {
      const content = isOffice ? await officeEditorRef.current?.save() : useEditorStore.getState().draft;
      if (content == null) throw new Error(t('failedToSaveFile'));
      const blob = content.startsWith('base64:')
        ? new Blob([Uint8Array.from(atob(content.slice(7)), (char) => char.charCodeAt(0))])
        : new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = currentFile.path.split('/').pop() || 'recovered-file';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failedToSaveFile'));
    }
  };

  const discardUnavailableDocument = () => {
    useFileStore.getState().clearCurrentFile();
    useEditorStore.getState().clear();
    onClosePreview?.();
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        const { activePath: pathToSave, draft: contentToSave } =
          useEditorStore.getState();
        if (!pathToSave) return;
        if (useFileStore.getState().currentFile?.unavailable) {
          toast.error(t('unavailableLocalChanges'));
          return;
        }
        if (isSceneCollaboration && currentFilePath === pathToSave) return;
        if (isCrdtCollaboration && currentFilePath === pathToSave) {
          if (!activeCollaborationDocument) {
            toast.error(t('collaboration.connecting'));
            return;
          }
          void activeCollaborationDocument.requestCheckpoint().catch((error) => {
            toast.error(getSaveErrorMessage(error));
          });
          return;
        }
        if (activeExternalTextChangePath === pathToSave) {
          const message = t('externalChangeSaveBlocked');
          setSaveError(message);
          toast.error(message);
          return;
        }
        markSaving();
        saveTrackedFile(pathToSave, contentToSave)
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
            handleSaveError(error, pathToSave);
          });
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [activeCollaborationDocument, activeExternalTextChangePath, currentFilePath, getSaveErrorMessage, handleSaveError, isCrdtCollaboration, isSceneCollaboration, markSaved, markSaving, saveTrackedFile, setSaveError, t]);

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
    if (!currentFile?.path || !isText || isExcalidraw || currentFile.collaboration?.crdtCapable) return;

    const watchedFilePath = currentFile.path;
    const revalidateCleanFile = () => {
      if (document.visibilityState !== 'visible') return;
      const editorState = useEditorStore.getState();
      if (editorState.activePath !== watchedFilePath || editorState.isDirty) return;
      void refreshCurrentFileContent(watchedFilePath);
    };

    const handleVisibilityChange = () => revalidateCleanFile();
    window.addEventListener('focus', revalidateCleanFile);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', revalidateCleanFile);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentFile?.collaboration?.crdtCapable, currentFile?.path, isExcalidraw, isText, refreshCurrentFileContent]);

  const retryOperation = async () => {
    try {
      if (currentFile && (isDirty || isCrdtCollaboration || isSceneCollaboration)) {
        await useFileStore.getState().prepareCurrentFileForTransition();
      } else {
        const path = fileErrorPath || missingFilePath || currentFile?.path;
        if (path) await revealAndLoadFile(path, { workspaceId: currentFileWorkspaceId ?? undefined });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failedToLoadPreview'));
    }
  };
  const recoveryActions = (
    <div className="mt-3 flex flex-wrap justify-center gap-2">
      <Button variant="outline" size="sm" onClick={() => void retryOperation()}>{t('retryOperation')}</Button>
      {onClosePreview ? <Button variant="ghost" size="sm" onClick={handleClosePreview}>{t('closeUnavailableDocument')}</Button> : null}
    </div>
  );

  if (isLoadingFile && !currentFile) {
    const pendingPath = loadingFilePath ?? null;
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

  if (displayFileError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <AlertCircle className="h-6 w-6 text-destructive" />
        <p className="text-sm text-destructive">{displayFileError}</p>
        {recoveryActions}
      </div>
    );
  }

  if (!currentFile && missingFilePath) {
    return (
      <div
        data-testid="missing-file-notice"
        role="status"
        className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground"
      >
        <Info className="h-6 w-6" />
        <p className="text-sm font-medium text-foreground">{t('fileUnavailableTitle')}</p>
        <p className="max-w-md text-sm">{t('fileUnavailableDescription')}</p>
        <p className="max-w-md break-all font-mono text-xs">{missingFilePath}</p>
        {recoveryActions}
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

  if (activePath !== currentFile.path) {
    return <FileLoadingSkeleton path={currentFile.path} />;
  }

  return (
    <>
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      {isLoadingFile && loadingFilePath !== currentFile.path ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/55 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground shadow-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{loadingFilePath}</span>
          </div>
        </div>
      ) : null}
      {backgroundFileError ? (
        <div className="absolute left-1/2 top-12 z-40 flex max-w-[min(90%,36rem)] -translate-x-1/2 items-start gap-2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-sm text-destructive shadow-md">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{backgroundFileError}</span>
          {!activeExternalTextChange ? <Button variant="outline" size="sm" onClick={() => void retryOperation()}>{t('retryOperation')}</Button> : null}
        </div>
      ) : null}
      <TooltipProvider delayDuration={150}>
        <div className="grid h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 overflow-hidden border-b border-border px-3 py-2 text-sm text-muted-foreground sm:px-4">
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground sm:gap-2">
            <span className="shrink-0 text-foreground">{t('fileLabel')}</span>
            <div className="flex min-w-0 items-center overflow-hidden">
              {breadcrumbs.map((segment, index) => (
                <span key={`segment-${segment}-${index}`} className="min-w-0 truncate">
                  {index > 0 && <span className="mx-0.5 text-muted-foreground/50">/</span>}
                  {segment}
                </span>
              ))}
            </div>
          </div>
          <div className="flex min-w-0 shrink-0 items-center justify-end gap-1 text-xs text-muted-foreground">
            {isHtml && (
              <>
                {htmlViewMode === 'preview' && (
                  <FileHeaderTooltip label={t('refreshPreview')}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => setHtmlRefreshKey((k) => k + 1)}
                      aria-label={t('refreshPreview')}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  </FileHeaderTooltip>
                )}
                <FileHeaderTooltip label={htmlViewMode === 'code' ? 'Preview' : 'Code'}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 2xl:w-auto 2xl:gap-1 2xl:px-2"
                    onClick={() => setCurrentHtmlViewMode((m) => (m === 'code' ? 'preview' : 'code'))}
                    aria-label={htmlViewMode === 'code' ? 'Preview' : 'Code'}
                  >
                    {htmlViewMode === 'code' ? (
                      <><Eye className="h-3.5 w-3.5" /><span className="hidden 2xl:inline">Preview</span></>
                    ) : (
                      <><Code2 className="h-3.5 w-3.5" /><span className="hidden 2xl:inline">Code</span></>
                    )}
                  </Button>
                </FileHeaderTooltip>
              </>
            )}
            {isMarpMarkdownFile && (
              <>
                {markdownViewMode === 'slides' && (
                  <FileHeaderTooltip label={t('refreshPreview')}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => setMarpRefreshKey((key) => key + 1)}
                      aria-label={t('refreshPreview')}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  </FileHeaderTooltip>
                )}
                <FileHeaderTooltip label={markdownViewMode === 'markdown' ? t('slidesPreview') : t('markdownEditor')}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 2xl:w-auto 2xl:gap-1 2xl:px-2"
                    onClick={() => {
                      setMarkdownViewOverride({
                        path: documentIdentity,
                        mode: markdownViewMode === 'markdown' ? 'slides' : 'markdown',
                      });
                    }}
                    aria-label={markdownViewMode === 'markdown' ? t('slidesPreview') : t('markdownEditor')}
                  >
                    {markdownViewMode === 'markdown' ? (
                      <><Presentation className="h-3.5 w-3.5" /><span className="hidden 2xl:inline">{t('slidesPreview')}</span></>
                    ) : (
                      <><Code2 className="h-3.5 w-3.5" /><span className="hidden 2xl:inline">{t('markdownEditor')}</span></>
                    )}
                  </Button>
                </FileHeaderTooltip>
              </>
            )}
            {isImage && <span className="shrink-0 bg-muted px-2 py-0.5 text-foreground">{t('readOnly')}</span>}
            {collaborationLabel ? (
              <FileHeaderTooltip label={collaborationLabel}>
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center gap-1 rounded-sm border border-border bg-muted px-0 text-xs text-muted-foreground 2xl:w-auto 2xl:px-2"
                  aria-label={collaborationLabel}
                >
                  <Lock className="h-3.5 w-3.5" />
                  <span className="hidden max-w-36 truncate 2xl:inline">{collaborationLabel}</span>
                </span>
              </FileHeaderTooltip>
            ) : null}
            {(isMarkdown || isHtml || isPdf) && (
              <FileHeaderTooltip label={isPdf ? t('downloadPdf') : isMarpMarkdownFile ? t('exportMarpSlides') : t('share')}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-xs 2xl:w-auto 2xl:gap-1.5 2xl:px-2"
                  onClick={handleShareAction}
                  aria-label={isPdf ? t('downloadPdf') : isMarpMarkdownFile ? t('exportMarpSlides') : t('share')}
                >
                  <Share2 className="h-3.5 w-3.5" />
                  <span className="hidden 2xl:inline">
                    {isMarpMarkdownFile ? t('exportMarpSlides') : t('share')}
                  </span>
                </Button>
              </FileHeaderTooltip>
            )}
            {collaboration?.crdtCapable && collaboration.document?.id ? (
              <CollaborationAgentOperations
                documentId={collaboration.document.id}
                onOperationsChange={handleAgentOperationsChange}
              />
            ) : null}
            {displaySaveError ? (
              <FileHeaderTooltip label={displaySaveError}>
                <span
                  className="flex h-6 max-w-36 shrink-0 items-center justify-center gap-1 rounded-sm px-1.5 text-xs text-destructive"
                  aria-label={displaySaveError}
                  role="status"
                >
                  <AlertCircle className="h-3.5 w-3.5" />
                  <span className="truncate">{displaySaveError}</span>
                </span>
              </FileHeaderTooltip>
            ) : null}
            <FileActionsDropdown
              node={currentFileNode}
              showCreateActions={false}
              showMultiSelectActions={false}
              contentProps={{ align: 'end' }}
            >
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0"
                aria-label={t('fileActions')}
                title={t('fileActions')}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </FileActionsDropdown>
            {onClosePreview ? (
              <FileHeaderTooltip label="Close preview">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 shrink-0 p-0"
                  onClick={() => void handleClosePreview()}
                  disabled={isSaving}
                  aria-label="Close preview"
                >
                  {isSaving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                </Button>
              </FileHeaderTooltip>
            ) : null}
          </div>
        </div>
      </TooltipProvider>
      {documentSyncStatus === 'updating' || documentSyncStatus === 'updated' || documentSyncStatus === 'error' ? <div role="status" title={formatTimestamp(lastSavedAt) ?? undefined} className="shrink-0 border-b px-3 py-1 text-xs text-muted-foreground">{t(documentSyncStatus === 'updating' ? 'documentUpdating' : documentSyncStatus === 'updated' ? 'documentUpdated' : 'documentUpdateFailed')}</div> : null}
      {currentFile.unavailable ? (
        <div role="status" data-testid="unavailable-document-recovery" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-2 text-xs">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{t('unavailableLocalChanges')}</span>
          {(isText || isExcalidraw || (isOffice && extension !== 'pptx')) ? (
            <Button variant="outline" size="sm" onClick={() => void downloadLocalRecovery()}>{t('downloadLocalChanges')}</Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={discardUnavailableDocument}>{t('discardUnavailableDocument')}</Button>
        </div>
      ) : null}
      {activeExternalTextChange ? (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-muted/60 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="flex min-w-0 items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0">
              <div className="font-medium text-foreground">{t('externalChangeTitle')}</div>
              <div className="text-muted-foreground">{t('externalChangeDescription')}</div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => void handleReloadExternalTextChange()}
              disabled={isResolvingExternalTextChange}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('externalChangeReload')}
            </Button>
            {!isOffice && !isExcalidraw && <Button
              variant="secondary"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => void handleMergeExternalTextChange()}
              disabled={isResolvingExternalTextChange}
            >
              <GitBranch className="h-3.5 w-3.5" />
              {t('externalChangeMerge')}
            </Button>}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => void handleSaveExternalTextCopy()}
              disabled={isResolvingExternalTextChange}
            >
              <FileText className="h-3.5 w-3.5" />
              {t('externalChangeCopy')}
            </Button>
          </div>
        </div>
      ) : null}
      <div className={isImage || isVideo || isMarkdown || isHtml || isExcalidraw ? 'min-h-0 flex-1 overflow-hidden' : (isOffice && extension !== 'docx' ? 'min-h-0 flex-1 relative' : 'min-h-0 flex-1 overflow-auto')}>
        <EditorErrorBoundary editorKind={editorKind} resetKey={currentFile.path}>
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
              <ImageViewer path={currentFile.path} previewSrc={withDocumentRevision(toPreviewUrl(currentFile.path, 1280, { workspaceId: currentFileWorkspaceId }), documentRevision)} fullSrc={mediaSource} />

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
              ref={officeEditorRef}
              key={`${documentIdentity}:${officeReloadKey}`}
              contentRevision={documentRevision}
              preserveSnapshot
              sourceUrl={withDocumentRevision(workspaceDownloadUrl(currentFile.path, { workspaceId: currentFileWorkspaceId }), documentRevision)}
              path={currentFile.path} 
              extension={extension} 
              updateDraft={updateDraft}
              onChange={() => {}}
            />
          ) : isPdf ? (
            <PdfViewer key={documentIdentity} path={currentFile.path} sourceUrl={mediaSource} />
          ) : isAudio ? (
            <MediaViewer
              key={documentIdentity}
              sourceUrl={mediaSource}
              path={currentFile.path}
              kind="audio"
              mimeType={mediaMimeType}
              size={currentFile.stats?.size}
            />
          ) : isVideo ? (
            <MediaViewer
              key={documentIdentity}
              sourceUrl={mediaSource}
              path={currentFile.path}
              kind="video"
              mimeType={mediaMimeType}
              size={currentFile.stats?.size}
            />
          ) : isHtml ? (
            <HtmlViewer path={currentFile.path} value={draft} onChange={updateDraft} viewMode={htmlViewMode} revision={documentRevision} refreshKey={htmlRefreshKey} lastSavedAt={lastSavedAt} />
          ) : isExcalidraw ? (
            <ExcalidrawEditor
              documentIdentity={documentIdentity}
              externalCollaboration={sceneDocument}
              path={currentFile.path}
              value={draft}
              onChange={isSceneCollaboration ? syncCollaborativeDraft : updateDraft}
              collaborationEnabled={Boolean(collaboration?.sceneCapable)}
            />
          ) : isMarkdown ? (
            isMarpMarkdownFile && markdownViewMode === 'slides' ? (
              <MarpPreview path={currentFile.path} content={draft} refreshKey={marpRefreshKey} />
            ) : (
              <MarkdownEditor
                key={documentIdentity}
                externalCollaboration={{ resolution: textSession, document: activeCollaborationDocument }}
                value={draft}
                onChange={updateCollaborativeDraft}
                filePath={currentFile.path}
                collaborationEnabled={Boolean(collaboration?.crdtCapable)}
                agentTargets={agentTargets}
                showNotebookMetadata
              />
            )
          ) : (
            <CodeEditor
              value={draft}
              onChange={updateCollaborativeDraft}
              readOnly={false}
              path={currentFile.path}
              collaborationEnabled={Boolean(collaboration?.crdtCapable)}
              collaborationSession={textSession.session}
              collaborationDocument={activeCollaborationDocument}
              agentTargets={agentTargets}
            />
          )}
        </EditorErrorBoundary>
      </div>
    </div>
    {((isMarkdown && !isMarpMarkdownFile) || isHtml) && currentFile && (
      <ShareMarkdownDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        filePath={currentFile.path}
        fileName={breadcrumbs[breadcrumbs.length - 1] ?? currentFile.path}
        kind={isHtml ? 'html' : 'markdown'}
      />
    )}
    {isMarpMarkdownFile && currentFile && (
      <MarpExportDialog
        open={marpExportOpen}
        onOpenChange={setMarpExportOpen}
        filePath={currentFile.path}
        fileName={breadcrumbs[breadcrumbs.length - 1] ?? currentFile.path}
      />
    )}
    </>
  );
}
