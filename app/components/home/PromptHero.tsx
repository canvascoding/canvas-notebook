'use client';

import React, { FormEvent, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { getPathname } from '@/i18n/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Send, Paperclip, Loader2, NotebookPen, Sparkles, Upload } from 'lucide-react';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { clearCanvasChatActiveSessionStorage, CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '@/app/lib/chat/constants';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { MAIN_AGENT_DISPLAY_NAME } from '@/app/lib/agents/main-agent';
import { ChatAgentSelector } from '@/app/components/canvas-agent-chat/ChatAgentSelector';
import { TypewriterPromptSuggestion } from '@/app/components/canvas-agent-chat/TypewriterPromptSuggestion';
import { AttachmentPreviewDialog } from '@/app/components/canvas-agent-chat/AttachmentPreviewDialog';
import { AttachmentPreviewItem } from '@/app/components/canvas-agent-chat/AttachmentPreviewItem';
import { useChatFileDrop } from '@/app/components/canvas-agent-chat/useChatFileDrop';
import { deriveUploadAttachmentPreview, type ChatAttachment } from '@/app/lib/chat/attachment-preview';
import { ImagePreprocessDialog } from '@/app/components/shared/ImagePreprocessDialog';
import type {
  ConvertParams,
  ImagePreprocessProgressItem,
  ImagePreprocessProgressStatus,
} from '@/app/components/shared/ImagePreprocessDialog';
import { isHeicUploadFile, shouldPreprocessImageFile } from '@/app/lib/images/client-preprocess';
import { prepareImageFilesForUpload, serializeUploadConvertParams } from '@/app/lib/images/client-upload-conversion';
import { fetchChatAgents } from '@/app/lib/chat/agent-api';
import { fetchLastActiveAgentId, saveLastActiveAgentId } from '@/app/lib/chat/agent-preferences';
import { getAgentProfileDisplayName } from '@/app/lib/chat/agent-display';
import type { AgentProfile } from '@/app/lib/chat/types';
import { listWorkspaceFileReferences, type WorkspaceFileReferenceEntry } from '@/app/lib/files/client';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { HomeStudioPrompt } from './HomeStudioPrompt';

type Attachment = ChatAttachment;
type UploadProgressOptions = {
  progressIndex?: number;
};

type FilePickerFile = WorkspaceFileReferenceEntry;
export type HomePromptMode = 'notebook' | 'studio';

interface PromptHeroProps {
  onModeChange?: (mode: HomePromptMode) => void;
}

const DEFAULT_AGENT_PROFILE: AgentProfile = {
  agentId: DEFAULT_AGENT_ID,
  name: MAIN_AGENT_DISPLAY_NAME,
  iconId: 'bot',
  type: 'main',
  removable: false,
};

function createProgressItems(files: File[]): ImagePreprocessProgressItem[] {
  return files.map((file) => ({
    fileName: file.name,
    size: file.size,
    status: 'queued',
  }));
}

export function PromptHero({ onModeChange }: PromptHeroProps = {}) {
  const locale = useLocale();
  const tHome = useTranslations('home');
  const tChat = useTranslations('chat');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<HomePromptMode>('notebook');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [agentListState, setAgentListState] = useState<{
    workspaceId: string | null;
    agents: AgentProfile[];
  }>({ workspaceId: null, agents: [] });
  const [selectedAgentId, setSelectedAgentId] = useState(DEFAULT_AGENT_ID);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [showFilePicker, setShowFilePicker] = useState(false);
  const [, setFilePickerQuery] = useState('');
  const [filePickerFiles, setFilePickerFiles] = useState<FilePickerFile[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const filePickerRef = useRef<HTMLDivElement>(null);

  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [imagePreprocessFiles, setImagePreprocessFiles] = useState<import('@/app/components/shared/ImagePreprocessDialog').PreprocessFileInfo[] | null>(null);
  const [imagePreprocessPendingFiles, setImagePreprocessPendingFiles] = useState<File[]>([]);
  const [imagePreprocessProgressItems, setImagePreprocessProgressItems] = useState<ImagePreprocessProgressItem[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const isUploading = pendingUploads > 0;
  const notebookHref = getPathname({ href: '/notebook', locale });
  const studioHref = getPathname({ href: '/studio', locale });
  const isStudioMode = mode === 'studio';
  const handleModeChange = (nextMode: HomePromptMode) => {
    setMode(nextMode);
    onModeChange?.(nextMode);
  };
  const availableAgents = useMemo(() => (
    agentListState.workspaceId === activeWorkspaceId ? agentListState.agents : []
  ), [activeWorkspaceId, agentListState]);
  const agentOptions = useMemo(() => (
    (availableAgents.length > 0 ? availableAgents : [DEFAULT_AGENT_PROFILE])
      .map((agent) => ({
        ...agent,
        name: getAgentProfileDisplayName(agent.agentId, agent.name),
      }))
  ), [availableAgents]);
  const selectedAgent = agentOptions.find((agent) => agent.agentId === selectedAgentId);
  const effectiveSelectedAgentId = selectedAgent?.agentId || DEFAULT_AGENT_ID;
  const selectedAgentName = getAgentProfileDisplayName(effectiveSelectedAgentId, selectedAgent?.name);
  const promptSuggestions = useMemo(() => (
    isStudioMode
      ? [
        tHome('focus.composer.studioSuggestions.product'),
        tHome('focus.composer.studioSuggestions.campaign'),
        tHome('focus.composer.studioSuggestions.editorial'),
      ]
      : [
        tChat('promptSuggestions.campaign'),
        tChat('promptSuggestions.creative'),
        tChat('promptSuggestions.strategy'),
      ]
  ), [isStudioMode, tChat, tHome]);

  useEffect(() => {
    let isActive = true;

    const loadAgentState = async () => {
      if (!activeWorkspaceId) return;
      try {
        const [agents, lastActiveAgentId] = await Promise.all([
          fetchChatAgents(activeWorkspaceId),
          fetchLastActiveAgentId(),
        ]);
        if (!isActive) return;

        setAgentListState({ workspaceId: activeWorkspaceId, agents });
        const hasStoredAgent = agents.length === 0 || agents.some((agent) => agent.agentId === lastActiveAgentId);
        setSelectedAgentId(hasStoredAgent ? lastActiveAgentId : DEFAULT_AGENT_ID);
      } catch (error) {
        console.error('Failed to load home agent selector state', error);
        if (isActive) {
          setAgentListState({ workspaceId: activeWorkspaceId, agents: [DEFAULT_AGENT_PROFILE] });
          setSelectedAgentId(DEFAULT_AGENT_ID);
        }
      }
    };

    void loadAgentState();

    return () => {
      isActive = false;
    };
  }, [activeWorkspaceId]);

  const handleAgentSelect = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    void saveLastActiveAgentId(agentId);
  }, []);

  const updateImagePreprocessProgress = useCallback((
    index: number,
    status: ImagePreprocessProgressStatus,
    detail?: string,
  ) => {
    setImagePreprocessProgressItems((current) => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, status, detail } : item
    )));
  }, []);

  const handleFileUploadMultiple = useCallback(async (
    files: File[],
    convertParams?: (ConvertParams | null)[],
    options: UploadProgressOptions = {},
  ): Promise<boolean> => {
    if (files.length === 0) {
      return true;
    }
    setPendingUploads((count) => count + 1);
    setUploadError(null);

    try {
      const prepared = await prepareImageFilesForUpload(files, convertParams, {
        onProgress: (progress) => {
          if (options.progressIndex === undefined) return;
          if (progress.status === 'processing') {
            updateImagePreprocessProgress(options.progressIndex, 'processing');
          } else if (progress.status === 'prepared' || progress.status === 'server-fallback') {
            updateImagePreprocessProgress(options.progressIndex, 'uploading');
          }
        },
      });
      if (options.progressIndex !== undefined) {
        updateImagePreprocessProgress(options.progressIndex, 'uploading');
      }
      const formData = new FormData();
      prepared.files.forEach((file) => formData.append('file', file));

      const serializedConvertParams = serializeUploadConvertParams(prepared.convertParams);
      if (serializedConvertParams) {
        formData.append('convertParams', serializedConvertParams);
      }

      const res = await fetch('/api/upload/attachment', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error ?? 'Upload failed');
      }

      const uploadedFiles = data.files || [];
      const newAttachments: Attachment[] = uploadedFiles.map((uploadedFile: {
        id: string;
        originalName: string;
        mimeType: string;
        size?: number;
        category: string;
      }) => {
        const isImage = uploadedFile.category === 'image';
        return deriveUploadAttachmentPreview({
          name: uploadedFile.originalName,
          contentKind: isImage ? 'image' : 'document',
          id: uploadedFile.id,
          mimeType: uploadedFile.mimeType,
          size: uploadedFile.size,
          category: uploadedFile.category,
        });
      });

      setAttachments((prev) => [...prev, ...newAttachments]);

      if (data.errors && data.errors.length > 0) {
        setUploadError(`Some files could not be uploaded: ${data.errors.join(', ')}`);
      }
      if (options.progressIndex !== undefined) {
        updateImagePreprocessProgress(options.progressIndex, data.errors?.length ? 'error' : 'success', data.errors?.join(', '));
      }
      return !data.errors?.length;
    } catch (err) {
      console.error('Upload failed', err);
      const message = err instanceof Error ? err.message : 'Upload failed. Network error or server unreachable.';
      setUploadError(message);
      if (options.progressIndex !== undefined) {
        updateImagePreprocessProgress(options.progressIndex, 'error', message);
      }
      return false;
    } finally {
      setPendingUploads((count) => Math.max(0, count - 1));
    }
  }, [updateImagePreprocessProgress]);

  const preprocessAndUpload = useCallback(async (files: File[]) => {
    const preprocessFiles: import('@/app/components/shared/ImagePreprocessDialog').PreprocessFileInfo[] = [];
    const normalFiles: File[] = [];

    for (const file of files) {
      const preprocessInfo = shouldPreprocessImageFile(file);
      if (preprocessInfo) {
        preprocessFiles.push({ file, ...preprocessInfo });
      } else {
        normalFiles.push(file);
      }
    }

    if (normalFiles.length > 0) {
      await handleFileUploadMultiple(normalFiles);
    }
    if (preprocessFiles.length > 0) {
      setImagePreprocessProgressItems([]);
      setImagePreprocessPendingFiles(preprocessFiles.map((f) => f.file));
      setImagePreprocessFiles(preprocessFiles);
    }
  }, [handleFileUploadMultiple]);

  const handleImagePreprocessConfirm = useCallback(async (convertParams: (ConvertParams | null)[]) => {
    setImagePreprocessProgressItems(createProgressItems(imagePreprocessPendingFiles));
    setPendingUploads((count) => count + 1);
    try {
      for (let index = 0; index < imagePreprocessPendingFiles.length; index += 1) {
        await handleFileUploadMultiple(
          [imagePreprocessPendingFiles[index]],
          [convertParams[index] ?? null],
          { progressIndex: index },
        );
      }
    } finally {
      setPendingUploads((count) => Math.max(0, count - 1));
    }
    setImagePreprocessPendingFiles([]);
  }, [handleFileUploadMultiple, imagePreprocessPendingFiles]);

  const handleImagePreprocessSkip = useCallback(async () => {
    setImagePreprocessProgressItems(createProgressItems(imagePreprocessPendingFiles));
    setPendingUploads((count) => count + 1);
    try {
      for (let index = 0; index < imagePreprocessPendingFiles.length; index += 1) {
        const file = imagePreprocessPendingFiles[index];
        if (isHeicUploadFile(file)) {
          updateImagePreprocessProgress(index, 'skipped');
          continue;
        }
        await handleFileUploadMultiple([file], undefined, { progressIndex: index });
      }
    } finally {
      setPendingUploads((count) => Math.max(0, count - 1));
    }
    setImagePreprocessPendingFiles([]);
  }, [handleFileUploadMultiple, imagePreprocessPendingFiles, updateImagePreprocessProgress]);

  const uploadFiles = useCallback((fileList: File[] | FileList | null | undefined) => {
    const files = Array.from(fileList || []);
    if (files.length > 0) {
      void preprocessAndUpload(files);
    }
  }, [preprocessAndUpload]);

  const onFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    uploadFiles(event.target.files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [uploadFiles]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    const pastedImages: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const renamedFile = new File([file], `screenshot-${timestamp}.png`, { type: file.type });
          pastedImages.push(renamedFile);
        }
      }
    }
    if (pastedImages.length > 0) {
      void preprocessAndUpload(pastedImages);
    }
  }, [preprocessAndUpload]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const fetchFiles = useCallback(async (query: string = '') => {
    setIsLoadingFiles(true);
    try {
      if (!activeWorkspaceId) throw new Error('Workspace context is not ready');
      setFilePickerFiles(await listWorkspaceFileReferences({ query, limit: 50, workspaceId: activeWorkspaceId }));
      setSelectedFileIndex(0);
    } catch (err) {
      console.error('Failed to fetch files', err);
    } finally {
      setIsLoadingFiles(false);
    }
  }, [activeWorkspaceId]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    setPrompt(value);

    const lastAtIndex = value.lastIndexOf('@', cursorPos);
    if (lastAtIndex !== -1 && cursorPos > lastAtIndex) {
      const textAfterAt = value.slice(lastAtIndex + 1, cursorPos);
      const hasSpace = textAfterAt.includes(' ');
      const hasCompletedQuote = textAfterAt.includes('"') && textAfterAt.indexOf('"') < textAfterAt.length - 1;
      const hasAnotherAt = textAfterAt.includes('@');

      if (!hasSpace && !hasCompletedQuote && !hasAnotherAt) {
        const query = textAfterAt;
        setFilePickerQuery(query);
        setShowFilePicker(true);
        void fetchFiles(query);
        return;
      }
    }

    setShowFilePicker(false);
  }, [fetchFiles]);

  const handleFileSelect = useCallback((file: FilePickerFile) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const value = prompt;
    const lastAtIndex = value.lastIndexOf('@', cursorPos);

    if (lastAtIndex !== -1) {
      const before = value.slice(0, lastAtIndex);
      const after = value.slice(cursorPos);
      const newValue = `${before}"${file.path}" ${after}`;
      setPrompt(newValue);
      setShowFilePicker(false);
      setFilePickerQuery('');

      setTimeout(() => {
        textarea.focus();
        const newCursorPos = before.length + file.path.length + 3;
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      }, 0);
    }
  }, [prompt]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showFilePicker && filePickerFiles.length > 0) {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedFileIndex((prev) =>
            prev < filePickerFiles.length - 1 ? prev + 1 : prev
          );
          return;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedFileIndex((prev) => (prev > 0 ? prev - 1 : 0));
          return;
        case 'Enter':
        case 'Tab':
          event.preventDefault();
          if (filePickerFiles[selectedFileIndex]) {
            handleFileSelect(filePickerFiles[selectedFileIndex]);
          }
          return;
        case 'Escape':
          setShowFilePicker(false);
          return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const normalizedPrompt = prompt.trim();
    if (isUploading) {
      return;
    }
    if (!normalizedPrompt && attachments.length === 0) {
      return;
    }

    setIsSubmitting(true);

    try {
      clearCanvasChatActiveSessionStorage();
      const data = {
        prompt: normalizedPrompt,
        attachments: attachments,
        agentId: effectiveSelectedAgentId,
      };
      window.sessionStorage.setItem(
        CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY,
        JSON.stringify(data)
      );
    } catch (error) {
      console.error('Failed to persist initial Canvas Chat prompt.', error);
    }

    window.location.assign(notebookHref);
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  const { isDraggingFiles, dropHandlers } = useChatFileDrop({
    disabled: isUploading || isStudioMode,
    onFiles: uploadFiles,
  });

  if (isStudioMode) {
    return (
      <div id="onboarding-home-promptHero" className="mx-auto w-full max-w-5xl">
        <div className="space-y-3">
          <h2 className="sr-only">{tHome('focus.composer.title')}</h2>
          <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/50 p-1" role="tablist" aria-label={tHome('focus.composer.modeLabel')}>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              onClick={() => handleModeChange('notebook')}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <NotebookPen className="h-3.5 w-3.5" />
              {tHome('focus.composer.notebook')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected
              className="inline-flex items-center gap-1.5 rounded-md bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow-sm"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {tHome('focus.composer.studio')}
            </button>
          </div>
          <HomeStudioPrompt studioHref={studioHref} />
        </div>
      </div>
    );
  }

  return (
    <>
    <div id="onboarding-home-promptHero" className="mx-auto w-full max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-3">
        <h2 className="sr-only">{tHome('focus.composer.title')}</h2>

        <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/50 p-1" role="tablist" aria-label={tHome('focus.composer.modeLabel')}>
          <button
            type="button"
            role="tab"
            aria-selected={!isStudioMode}
            onClick={() => handleModeChange('notebook')}
            className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${!isStudioMode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <NotebookPen className="h-3.5 w-3.5" />
            {tHome('focus.composer.notebook')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isStudioMode}
            onClick={() => handleModeChange('studio')}
            className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${isStudioMode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {tHome('focus.composer.studio')}
          </button>
        </div>

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 border border-border bg-muted/60 p-2">
            {attachments.map((attachment, index) => (
              <AttachmentPreviewItem
                key={`${attachment.id || attachment.filePath || attachment.name}-${index}`}
                attachment={attachment}
                context="composer"
                previewGroup={attachments}
                onRemove={() => removeAttachment(index)}
                onOpen={(selectedAttachment) => setPreviewAttachment(selectedAttachment)}
              />
            ))}
          </div>
        )}

        {isStudioMode && attachments.length > 0 ? (
          <p className="text-xs text-muted-foreground">{tHome('focus.composer.studioAttachmentHint')}</p>
        ) : null}

        {isUploading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {tChat('uploadingFiles')}
          </div>
        )}
        {uploadError && (
          <div className="text-xs text-destructive">{uploadError}</div>
        )}

        <div className="relative">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isStudioMode ? tHome('focus.composer.studioPlaceholder') : tHome('hero.placeholder')}
            data-prompt-hero-textarea
            className={`min-h-24 w-full resize-y rounded-lg border bg-background p-3 text-base focus:outline-none focus:ring-2 ${isDraggingFiles ? 'border-primary ring-2 ring-primary/30' : 'border-border focus:ring-ring'} ${prompt.length === 0 ? 'placeholder:text-transparent' : 'placeholder:text-muted-foreground'}`}
            rows={3}
            {...(!isStudioMode ? dropHandlers : {})}
          />
          {prompt.length === 0 ? (
            <TypewriterPromptSuggestion
              suggestions={promptSuggestions}
              testId="home-prompt-suggestion"
              className="left-0 right-0 top-0 overflow-hidden whitespace-nowrap px-3 py-3 text-base leading-normal"
            />
          ) : null}
          {isDraggingFiles && !isStudioMode ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border border-primary bg-background/90 text-xs font-medium text-primary">
              <span className="inline-flex items-center gap-2">
                <Upload className="h-4 w-4" />
                {tChat('dropFilesHere')}
              </span>
            </div>
          ) : null}

          {showFilePicker && (
            <div
              ref={filePickerRef}
              className="absolute bottom-full left-0 mb-1 w-full max-h-48 overflow-y-auto border border-border bg-background shadow-lg z-50"
            >
              <div className="p-2 text-xs text-muted-foreground border-b border-border">
                {isLoadingFiles ? tChat('loadingFiles') : tChat('filesFound', { count: filePickerFiles.length })}
              </div>
              {filePickerFiles.map((file, index) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => handleFileSelect(file)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                    index === selectedFileIndex ? 'bg-accent' : ''
                  }`}
                >
                  {getFileIconComponent({
                    name: file.name,
                    path: file.path,
                    type: file.type,
                  })}
                  <span className="truncate">{file.name}</span>
                  {file.type === 'directory' && (
                    <span className="text-xs text-muted-foreground ml-auto">{tHome('chatPrompt.directoryBadge')}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          {isStudioMode ? (
            <p className="text-xs text-muted-foreground">{tHome('focus.composer.studioDescription')}</p>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-10 w-10 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-accent"
                title={tChat('attachImage')}
              >
                <Paperclip className="h-5 w-5" />
              </button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={onFileChange}
                className="hidden"
                accept="image/*,application/pdf,.docx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html"
                multiple
              />
              <ChatAgentSelector
                variant="desktop"
                activeAgentId={effectiveSelectedAgentId}
                activeAgentName={selectedAgentName}
                activeAgentIconId={selectedAgent?.iconId}
                agents={agentOptions}
                className="max-w-[11rem] bg-background"
                testId="home-agent-id"
                onSelectAgent={handleAgentSelect}
                onReloadAgents={async () => {
                  if (!activeWorkspaceId) return;
                  setAgentListState({
                    workspaceId: activeWorkspaceId,
                    agents: await fetchChatAgents(activeWorkspaceId),
                  });
                }}
              />
            </div>
          )}

          <button
            type="submit"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 sm:px-4"
            disabled={isSubmitting || isUploading || (!prompt.trim() && (isStudioMode || attachments.length === 0))}
          >
            {isStudioMode ? <Sparkles className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            <span className="sr-only sm:not-sr-only">{isStudioMode ? tHome('focus.composer.studioSubmit') : tHome('hero.submit')}</span>
          </button>
        </div>
      </form>
    </div>

    <AttachmentPreviewDialog
      attachment={previewAttachment}
      attachments={attachments}
      onClose={() => setPreviewAttachment(null)}
    />
    <ImagePreprocessDialog
      open={imagePreprocessFiles !== null}
      onOpenChange={(open) => {
        if (!open) {
          setImagePreprocessFiles(null);
          setImagePreprocessPendingFiles([]);
          setImagePreprocessProgressItems([]);
        }
      }}
      files={imagePreprocessFiles ?? []}
      onConfirm={handleImagePreprocessConfirm}
      onSkip={handleImagePreprocessSkip}
      isProcessing={isUploading}
      progressItems={imagePreprocessProgressItems}
    />
    </>
  );
}
