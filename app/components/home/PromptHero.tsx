'use client';

import React, { FormEvent, useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect } from 'react';
import { getPathname, useRouter } from '@/i18n/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Send, Paperclip, Loader2, NotebookPen, Sparkles, Upload, AtSign } from 'lucide-react';
import { clearCanvasChatActiveSessionStorage, CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '@/app/lib/chat/constants';
import { createPromptHandoff, persistPromptHandoff } from '@/app/lib/chat/prompt-handoff';
import { captureChatSendValue } from '@/app/lib/chat/send-transaction';
import { parseChatBody, projectChatBodyText, type ChatBodyV1 } from '@/app/lib/chat/chat-body-contracts';
import { createTextChatBody } from '@/app/lib/chat/body-state';
import { ChatInlineEditor, type ChatInlineEditorHandle } from '@/app/components/canvas-agent-chat/ChatInlineEditor';
import { useComposerReferences } from '@/app/components/canvas-agent-chat/useComposerReferences';
import { useChatReferencePresentation } from '@/app/components/canvas-agent-chat/useChatReferencePresentation';
import { ChatExtensionReferenceDialog } from '@/app/components/canvas-agent-chat/ChatExtensionReferenceDialog';
import { ComposerReferencePicker } from '@/app/components/canvas-agent-chat/ComposerReferencePicker';
import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
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
import { useChatAgentList } from '@/app/components/canvas-agent-chat/useChatAgentList';
import { fetchLastActiveAgentId, saveLastActiveAgentId } from '@/app/lib/chat/agent-preferences';
import { getAgentProfileDisplayName } from '@/app/lib/chat/agent-display';
import type { AgentProfile } from '@/app/lib/chat/types';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { HomeStudioPrompt } from './HomeStudioPrompt';

type Attachment = ChatAttachment;
type UploadProgressOptions = {
  progressIndex?: number;
};

export type HomePromptMode = 'notebook' | 'studio';
export type HomePlainTextPromptRequest = { id: string; workspaceId: string; text: string };

interface PromptHeroProps {
  onModeChange?: (mode: HomePromptMode) => void;
  compact?: boolean;
  plainTextRequest?: HomePlainTextPromptRequest | null;
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

export function PromptHero({ onModeChange, compact = false, plainTextRequest }: PromptHeroProps = {}) {
  const locale = useLocale();
  const router = useRouter();
  const tHome = useTranslations('home');
  const tChat = useTranslations('chat');
  const [promptBody, setPromptBody] = useState<ChatBodyV1>(() => createTextChatBody(''));
  const prompt = useMemo(() => projectChatBodyText(promptBody), [promptBody]);
  const [expanded, setExpanded] = useState(!compact);
  const [mode, setMode] = useState<HomePromptMode>('notebook');
  const activeWorkspaceId = useWorkspaceStore((state) => selectActiveWorkspace(state)?.id ?? null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const { availableAgents, refreshAgents, acceptCreatedAgent, scopeKey } = useChatAgentList(activeWorkspaceId);
  const [selectedAgentId, setSelectedAgentId] = useState(DEFAULT_AGENT_ID);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<ChatInlineEditorHandle>(null);

  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [imagePreprocessFiles, setImagePreprocessFiles] = useState<import('@/app/components/shared/ImagePreprocessDialog').PreprocessFileInfo[] | null>(null);
  const [imagePreprocessPendingFiles, setImagePreprocessPendingFiles] = useState<File[]>([]);
  const [imagePreprocessProgressItems, setImagePreprocessProgressItems] = useState<ImagePreprocessProgressItem[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const isUploading = pendingUploads > 0;
  const studioHref = getPathname({ href: '/studio', locale });
  const isStudioMode = mode === 'studio';
  const handleModeChange = (nextMode: HomePromptMode) => {
    setMode(nextMode);
    onModeChange?.(nextMode);
  };
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
  const resetInputHistoryNavigation = useCallback(() => {}, []);
  const { target: referenceTarget, activeReferenceMatch, closeReferencePicker, handleInputChange,
    handleSelectionChange, handleReferenceSelect, referencePickerItems, selectedReferenceIndex,
    selectNextReference, selectPreviousReference, isLoadingReferenceItems, referencePickerError,
    openReferencePicker, referenceTypeFilter, setReferenceTypeFilter, pendingReference,
    referenceSourceStatuses, retryReferenceSource, configureReference,
    closeReferenceDialog, acceptReference, prepareIntakeSelection } = useComposerReferences({
    agentId: effectiveSelectedAgentId, sessionId: null, inputBody: promptBody, workspaceId: activeWorkspaceId,
    resetInputHistoryNavigation, setInputBody: setPromptBody, editorRef,
  });
  const referenceIcons = useChatReferencePresentation(referenceTarget, [promptBody]);
  const latestPrompt = useRef({ body: promptBody, attachments, agentId: effectiveSelectedAgentId, workspaceId: activeWorkspaceId });
  useLayoutEffect(() => { latestPrompt.current = { body: promptBody, attachments, agentId: effectiveSelectedAgentId,
    workspaceId: activeWorkspaceId }; }, [activeWorkspaceId, attachments, effectiveSelectedAgentId, promptBody]);
  useEffect(() => {
    if (!plainTextRequest || plainTextRequest.workspaceId !== activeWorkspaceId) return;
    const timer = setTimeout(() => {
      if (useWorkspaceStore.getState().activeWorkspaceId !== plainTextRequest.workspaceId) return;
      setPromptBody(createTextChatBody(plainTextRequest.text)); setExpanded(true); closeReferencePicker();
      requestAnimationFrame(() => editorRef.current?.focusEnd());
    }, 0);
    return () => clearTimeout(timer);
  }, [activeWorkspaceId, closeReferencePicker, plainTextRequest]);
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
        const lastActiveAgentId = await fetchLastActiveAgentId();
        if (!isActive) return;
        setSelectedAgentId(current => current === DEFAULT_AGENT_ID ? lastActiveAgentId : current);
      } catch (error) {
        if (!isActive) return;
        console.error('Failed to load home agent selector state', error);
      }
    };

    void loadAgentState();

    return () => {
      isActive = false;
    };
  }, [activeWorkspaceId, scopeKey]);

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
      setExpanded(true);
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

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    if (pendingReference && event.key === 'Escape') { event.preventDefault(); closeReferenceDialog(); return; }
    if (pendingReference && (event.key === 'Enter' && !event.shiftKey || event.key === 'Tab')) { event.preventDefault(); return; }
    if (activeReferenceMatch && event.key === 'Escape') {
      event.preventDefault(); closeReferencePicker(); return;
    }
    if (activeReferenceMatch) {
      if (event.key === 'ArrowDown') { event.preventDefault(); selectNextReference(); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); selectPreviousReference(); return; }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const item = referencePickerItems[selectedReferenceIndex];
        if (item) handleReferenceSelect(item);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void handleSubmit(); }
  };

  const handleSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const body = parseChatBody(promptBody), capturedAttachments = captureChatSendValue(attachments);
    const originalDraft = JSON.stringify({ body, attachments: capturedAttachments,
      agentId: effectiveSelectedAgentId, workspaceId: activeWorkspaceId });
    if (isUploading) {
      return;
    }
    if (!projectChatBodyText(body).trim() && capturedAttachments.length === 0) {
      return;
    }

    if (submittingRef.current) return;
    const workspace = useWorkspaceStore.getState();
    if (!workspace.initialized || !activeWorkspaceId || workspace.activeWorkspaceId !== activeWorkspaceId) {
      setSubmitError(tChat('errorMessage', { message: 'Select a workspace before starting this chat.' }));
      return;
    }
    const auth = openedDocumentAuthScope();
    if (!auth) {
      setSubmitError(tChat('errorMessage', { message: 'Your sign-in is still loading. Please try again.' }));
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Account seals stay exclusively in the scoped RAM cache. The handoff
      // stores only the exact public body, never the returned intake envelope.
      await prepareIntakeSelection(body);
      if (openedDocumentAuthScope() !== auth || useWorkspaceStore.getState().activeWorkspaceId !== activeWorkspaceId
        || JSON.stringify(latestPrompt.current) !== originalDraft) throw new Error(tChat('referenceInputChanged'));
      const payload = createPromptHandoff({ prompt: projectChatBodyText(body), body, attachments: capturedAttachments,
        agentId: effectiveSelectedAgentId, workspaceId: activeWorkspaceId, auth });
      persistPromptHandoff(window.sessionStorage, CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY, payload);
      clearCanvasChatActiveSessionStorage(activeWorkspaceId);
      router.push({ pathname: '/notebook', query: {
        workspaceId: activeWorkspaceId, chat: 'open', handoff: payload.handoffId,
      } });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : tChat('errorMessage', { message: String(error) }));
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (!compact) editorRef.current?.focus();
  }, [compact]);

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
    <div id="onboarding-home-promptHero" className="w-full">
      <form onSubmit={handleSubmit} onFocus={() => setExpanded(true)} className="space-y-3">
        <h2 className="sr-only">{tHome('focus.composer.title')}</h2>

        {expanded ? <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/50 p-1" role="tablist" aria-label={tHome('focus.composer.modeLabel')}>
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
        </div> : null}

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
        {submitError ? <div role="alert" className="text-xs text-destructive">{submitError}</div> : null}
        {uploadError && (
          <div className="text-xs text-destructive">{uploadError}</div>
        )}

        <div className="relative" data-home-prompt-editor {...(!isStudioMode ? dropHandlers : {})}>
          <ChatInlineEditor
            ref={editorRef}
            body={promptBody}
            icons={referenceIcons}
            onBodyChange={handleInputChange}
            onSelectionChange={handleSelectionChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={isSubmitting}
            placeholder={!compact && prompt.length === 0 ? '' : compact ? tHome('start.aiPlaceholder') : tHome('hero.placeholder')}
            aria-label={tHome('start.aiPlaceholder')}
            className={`${expanded ? 'min-h-24' : 'min-h-12'} max-h-[min(280px,40dvh)] w-full overflow-y-auto rounded-lg border bg-background p-3 text-base focus-within:outline-none focus-within:ring-2 ${isDraggingFiles ? 'border-primary ring-2 ring-primary/30' : 'border-border focus-within:ring-ring'}`}
          />
          {prompt.length === 0 && !compact ? (
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

          {activeReferenceMatch ? <ComposerReferencePicker
            locale={locale}
            header={isLoadingReferenceItems ? tChat('loadingReferences') : tChat('referencesFound', { count: referencePickerItems.length })}
            emptyState={referencePickerError ? tChat('referenceSearchFailed', { message: referencePickerError }) : tChat('noReferencesAvailable')}
            isLoading={isLoadingReferenceItems}
            items={referencePickerItems}
            selectedIndex={selectedReferenceIndex}
            onSelect={handleReferenceSelect}
            onConfigure={configureReference}
            canConfigure={item => { const payload = item.payload; const selection = payload.type === 'extension' ? payload.option.selection : payload.type === 'recent' ? payload.recent.bodyBundle.primary.selection : null;
              return selection?.kind === 'plugin' || selection?.kind === 'skill'; }}
            sourceStatuses={referenceSourceStatuses}
            onRetrySource={retryReferenceSource}
            notice={referencePickerError}
            headerActions={<div className="mt-2 flex flex-wrap gap-1" aria-label={tChat('referenceTypeFilter')}>
              {(['all', 'plugin', 'skill', 'integration', 'mcp'] as const).map(type => <button key={type} type="button"
                aria-pressed={referenceTypeFilter === type} onClick={() => setReferenceTypeFilter(type)}
                className={`rounded-md px-2 py-1 text-xs transition-colors ${referenceTypeFilter === type ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60'}`}>
                {type === 'all' ? tChat('referenceAllTypes') : type === 'integration' ? 'Composio' : type === 'mcp' ? 'MCP' : type === 'plugin' ? 'Plugins' : 'Skills'}
              </button>)}
            </div>}
          /> : null}
        </div>

        {expanded ? <div className="flex items-center justify-between gap-3">
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
              <button type="button" onClick={openReferencePicker} disabled={isSubmitting || !referenceTarget}
                title={tChat('openReferences')} aria-label={tChat('openReferences')}
                className="flex h-10 w-10 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-accent disabled:opacity-50">
                <AtSign className="h-4 w-4" />
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
                context={{ workspaceId: activeWorkspaceId }}
                variant="desktop"
                activeAgentId={effectiveSelectedAgentId}
                activeAgentName={selectedAgentName}
                activeAgentIconId={selectedAgent?.iconId}
                agents={agentOptions}
                className="max-w-[11rem] bg-background"
                testId="home-agent-id"
                onSelectAgent={handleAgentSelect}
                onAgentCreated={acceptCreatedAgent}
                onReloadAgents={refreshAgents}
              />
            </div>
          )}

          <button
            type="submit"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 sm:px-4"
            disabled={Boolean(pendingReference) || isSubmitting || isUploading || (!prompt.trim() && (isStudioMode || attachments.length === 0))}
          >
            {isStudioMode ? <Sparkles className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            <span className="sr-only sm:not-sr-only">{isStudioMode ? tHome('focus.composer.studioSubmit') : tHome('hero.submit')}</span>
          </button>
        </div> : null}
      </form>
    </div>

    {pendingReference ? <ChatExtensionReferenceDialog request={pendingReference}
      onClose={closeReferenceDialog} onSelect={acceptReference} /> : null}

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
