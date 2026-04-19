'use client';

import React, { FormEvent, useState, useRef, useCallback, useEffect } from 'react';
import { getPathname } from '@/i18n/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Send, Paperclip, X, Image as ImageIcon, FileText, Loader2 } from 'lucide-react';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '@/app/lib/chat/constants';
import { ImagePreprocessDialog } from '@/app/components/shared/ImagePreprocessDialog';
import type { ConvertParams } from '@/app/components/shared/ImagePreprocessDialog';

interface Attachment {
  name: string;
  contentKind: 'image' | 'document';
  id: string;
  mimeType?: string;
  category?: string;
}

interface FilePickerFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
  isImage: boolean;
}

export function PromptHero() {
  const locale = useLocale();
  const tHome = useTranslations('home');
  const tChat = useTranslations('chat');
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [showFilePicker, setShowFilePicker] = useState(false);
  const [, setFilePickerQuery] = useState('');
  const [filePickerFiles, setFilePickerFiles] = useState<FilePickerFile[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const filePickerRef = useRef<HTMLDivElement>(null);

  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [imagePreprocessFiles, setImagePreprocessFiles] = useState<import('@/app/components/shared/ImagePreprocessDialog').PreprocessFileInfo[] | null>(null);
  const [imagePreprocessPendingFiles, setImagePreprocessPendingFiles] = useState<File[]>([]);
  const notebookHref = getPathname({ href: '/notebook', locale });

  const handleFileUploadMultiple = useCallback(async (files: File[], convertParams?: (ConvertParams | null)[]) => {
    setIsUploading(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      files.forEach((file) => formData.append('file', file));

      if (convertParams && convertParams.length > 0) {
        const paramsSerializable = convertParams.map((p) =>
          p ? { format: p.format, quality: p.quality, maxDimension: p.maxDimension } : null
        );
        formData.append('convertParams', JSON.stringify(paramsSerializable));
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
        category: string;
      }) => {
        const isImage = uploadedFile.category === 'image';
        return {
          name: uploadedFile.originalName,
          contentKind: isImage ? 'image' : 'document',
          id: uploadedFile.id,
          mimeType: uploadedFile.mimeType,
          category: uploadedFile.category,
        };
      });

      setAttachments((prev) => [...prev, ...newAttachments]);

      if (data.errors && data.errors.length > 0) {
        setUploadError(`Some files could not be uploaded: ${data.errors.join(', ')}`);
      }
    } catch (err) {
      console.error('Upload failed', err);
      setUploadError(err instanceof Error ? err.message : 'Upload failed. Network error or server unreachable.');
    } finally {
      setIsUploading(false);
    }
  }, []);

  const preprocessAndUpload = useCallback(async (files: File[]) => {
    const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence']);
    const HEIC_EXTS = new Set(['heic', 'heif']);
    const SIZE_THRESHOLD = 1_500_000;
    const preprocessFiles: import('@/app/components/shared/ImagePreprocessDialog').PreprocessFileInfo[] = [];
    const normalFiles: File[] = [];

    for (const file of files) {
      const isHeic = HEIC_TYPES.has(file.type.toLowerCase()) || HEIC_EXTS.has(file.name.split('.').pop()?.toLowerCase() ?? '');
      const isImage = file.type.startsWith('image/') || HEIC_EXTS.has(file.name.split('.').pop()?.toLowerCase() ?? '');
      const isLarge = isImage && file.size > SIZE_THRESHOLD;
      if (isHeic || isLarge) {
        preprocessFiles.push({ file, isHeic, isLarge });
      } else {
        normalFiles.push(file);
      }
    }

    if (normalFiles.length > 0) {
      await handleFileUploadMultiple(normalFiles);
    }
    if (preprocessFiles.length > 0) {
      setImagePreprocessPendingFiles(preprocessFiles.map((f) => f.file));
      setImagePreprocessFiles(preprocessFiles);
    }
  }, [handleFileUploadMultiple]);

  const handleImagePreprocessConfirm = useCallback(async (convertParams: (ConvertParams | null)[]) => {
    await handleFileUploadMultiple(imagePreprocessPendingFiles, convertParams);
    setImagePreprocessFiles(null);
    setImagePreprocessPendingFiles([]);
  }, [handleFileUploadMultiple, imagePreprocessPendingFiles]);

  const handleImagePreprocessSkip = useCallback(async () => {
    const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence']);
    const HEIC_EXTS = new Set(['heic', 'heif']);
    const nonHeicFiles = imagePreprocessPendingFiles.filter((f) => {
      return !HEIC_TYPES.has(f.type.toLowerCase()) && !HEIC_EXTS.has(f.name.split('.').pop()?.toLowerCase() ?? '');
    });
    if (nonHeicFiles.length > 0) {
      await handleFileUploadMultiple(nonHeicFiles);
    }
    setImagePreprocessFiles(null);
    setImagePreprocessPendingFiles([]);
  }, [handleFileUploadMultiple, imagePreprocessPendingFiles]);

  const handleFileUpload = useCallback(async (file: File) => {
    await preprocessAndUpload([file]);
  }, [preprocessAndUpload]);

  const onFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) preprocessAndUpload(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [preprocessAndUpload]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i += 1) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const renamedFile = new File([file], `screenshot-${timestamp}.png`, { type: file.type });
          handleFileUpload(renamedFile);
        }
      }
    }
  }, [handleFileUpload]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const fetchFiles = useCallback(async (query: string = '') => {
    setIsLoadingFiles(true);
    try {
      const res = await fetch(`/api/files/list?q=${encodeURIComponent(query)}&limit=50`);
      const data = await res.json();
      if (data.success) {
        setFilePickerFiles(data.files);
        setSelectedFileIndex(0);
      }
    } catch (err) {
      console.error('Failed to fetch files', err);
    } finally {
      setIsLoadingFiles(false);
    }
  }, []);

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
    if (!normalizedPrompt && attachments.length === 0) {
      return;
    }

    setIsSubmitting(true);

    try {
      const data = {
        prompt: normalizedPrompt,
        attachments: attachments,
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

  return (
    <>
    <div id="onboarding-home-promptHero" className="mx-auto w-full max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-3">
        <h2 className="sr-only">{tHome('hero.placeholder')}</h2>

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 border border-border bg-muted/60 p-2">
            {attachments.map((attachment, index) => (
              <div key={index} className="flex items-center gap-2 border border-border bg-accent/70 p-1 px-2 text-xs">
                {attachment.contentKind === 'image' ? (
                  <ImageIcon className="h-3.5 w-3.5" />
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                {attachment.name}
                <button
                  type="button"
                  onClick={() => removeAttachment(index)}
                  className="hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

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
            placeholder={tHome('hero.placeholder')}
            data-prompt-hero-textarea
            className="min-h-24 w-full resize-y rounded-lg border border-border bg-background p-3 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            rows={3}
          />

          {showFilePicker && (
            <div
              ref={filePickerRef}
              className="absolute bottom-full left-0 mb-1 w-full max-h-48 overflow-y-auto border border-border bg-background shadow-lg z-50"
            >
              <div className="p-2 text-xs text-muted-foreground border-b border-border">
                {isLoadingFiles ? tChat('loadingFiles') : `${tChat('filesFound')}: ${filePickerFiles.length}`}
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
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="border border-transparent p-2 text-muted-foreground transition-colors hover:border-border hover:bg-accent rounded-md"
            title={tChat('attachImage')}
          >
            <Paperclip className="h-5 w-5" />
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={onFileChange}
            className="hidden"
            multiple
          />

          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
            disabled={isSubmitting || (!prompt.trim() && attachments.length === 0)}
          >
            <Send className="h-4 w-4" />
            {tHome('hero.submit')}
          </button>
        </div>
      </form>
    </div>

    <ImagePreprocessDialog
      open={imagePreprocessFiles !== null}
      onOpenChange={(open) => { if (!open) { setImagePreprocessFiles(null); setImagePreprocessPendingFiles([]); } }}
      files={imagePreprocessFiles ?? []}
      onConfirm={handleImagePreprocessConfirm}
      onSkip={handleImagePreprocessSkip}
    />
    </>
  );
}