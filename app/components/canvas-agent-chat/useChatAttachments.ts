'use client';

import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react';
import type { ConvertParams, PreprocessFileInfo } from '@/app/components/shared/ImagePreprocessDialog';
import {
  createImageAttachmentFromMediaUrl,
  deriveUploadAttachmentPreview,
  getAttachmentMediaUrl,
} from '@/app/lib/chat/attachment-preview';
import type { Attachment } from '@/app/lib/chat/types';

const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence']);
const HEIC_EXTENSIONS = new Set(['heic', 'heif']);
const LARGE_IMAGE_SIZE_THRESHOLD = 1_500_000;

type UploadedAttachmentFile = {
  id: string;
  originalName: string;
  mimeType: string;
  size?: number;
  category: string;
};

type UploadAttachmentResponse = {
  success: boolean;
  error?: string;
  errors?: string[];
  files?: UploadedAttachmentFile[];
};

type UseChatAttachmentsParams = {
  onMediaClick?: (mediaUrl: string) => void;
};

function getFileExtension(file: File): string {
  return file.name.split('.').pop()?.toLowerCase() ?? '';
}

function isHeicFile(file: File): boolean {
  return HEIC_TYPES.has(file.type.toLowerCase()) || HEIC_EXTENSIONS.has(getFileExtension(file));
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || HEIC_EXTENSIONS.has(getFileExtension(file));
}

async function readUploadAttachmentResponse(res: Response): Promise<UploadAttachmentResponse | null> {
  const text = await res.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as UploadAttachmentResponse;
  } catch {
    return null;
  }
}

export function useChatAttachments({ onMediaClick }: UseChatAttachmentsParams) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [imagePreprocessFiles, setImagePreprocessFiles] = useState<PreprocessFileInfo[] | null>(null);
  const [imagePreprocessPendingFiles, setImagePreprocessPendingFiles] = useState<File[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [previewAttachmentGroup, setPreviewAttachmentGroup] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isUploading = pendingUploads > 0;

  const handleFileUploadMultiple = useCallback(async (files: File[], convertParams?: (ConvertParams | null)[]) => {
    if (files.length === 0) {
      return;
    }
    setPendingUploads((count) => count + 1);
    setUploadError(null);

    try {
      const formData = new FormData();
      files.forEach((file) => formData.append('file', file));

      if (convertParams && convertParams.length > 0) {
        const paramsSerializable = convertParams.map((p) =>
          p ? { format: p.format, quality: p.quality, maxDimension: p.maxDimension } : null,
        );
        formData.append('convertParams', JSON.stringify(paramsSerializable));
      }

      const res = await fetch('/api/upload/attachment', { method: 'POST', body: formData });
      const data = await readUploadAttachmentResponse(res);

      if (!data || !data.success) {
        throw new Error(data?.error ?? 'Upload failed');
      }

      const nextAttachments: Attachment[] = (data.files || []).map((uploadedFile) => {
        const image = uploadedFile.category === 'image';
        return deriveUploadAttachmentPreview({
          name: uploadedFile.originalName,
          contentKind: image ? 'image' : 'document',
          id: uploadedFile.id,
          mimeType: uploadedFile.mimeType,
          size: uploadedFile.size,
          category: uploadedFile.category,
        });
      });

      setAttachments((prev) => [...prev, ...nextAttachments]);

      if (data.errors && data.errors.length > 0) {
        setUploadError(`Einige Dateien konnten nicht hochgeladen werden: ${data.errors.join(', ')}`);
      }
    } catch (err) {
      console.error('Upload failed', err);
      setUploadError(err instanceof Error ? err.message : 'Upload fehlgeschlagen. Netzwerkfehler oder Server nicht erreichbar.');
    } finally {
      setPendingUploads((count) => Math.max(0, count - 1));
    }
  }, []);

  const preprocessAndUpload = useCallback(async (files: File[]) => {
    const preprocessFiles: PreprocessFileInfo[] = [];
    const normalFiles: File[] = [];

    for (const file of files) {
      const heic = isHeicFile(file);
      const large = isImageFile(file) && file.size > LARGE_IMAGE_SIZE_THRESHOLD;
      if (heic || large) {
        preprocessFiles.push({ file, isHeic: heic, isLarge: large });
      } else {
        normalFiles.push(file);
      }
    }

    if (normalFiles.length > 0) {
      await handleFileUploadMultiple(normalFiles);
    }
    if (preprocessFiles.length > 0) {
      setImagePreprocessPendingFiles(preprocessFiles.map((fileInfo) => fileInfo.file));
      setImagePreprocessFiles(preprocessFiles);
    }
  }, [handleFileUploadMultiple]);

  const handleImagePreprocessConfirm = useCallback(async (convertParams: (ConvertParams | null)[]) => {
    await handleFileUploadMultiple(imagePreprocessPendingFiles, convertParams);
    setImagePreprocessFiles(null);
    setImagePreprocessPendingFiles([]);
  }, [handleFileUploadMultiple, imagePreprocessPendingFiles]);

  const handleImagePreprocessSkip = useCallback(async () => {
    const nonHeicFiles = imagePreprocessPendingFiles.filter((file) => !isHeicFile(file));
    if (nonHeicFiles.length > 0) {
      await handleFileUploadMultiple(nonHeicFiles);
    }
    setImagePreprocessFiles(null);
    setImagePreprocessPendingFiles([]);
  }, [handleFileUploadMultiple, imagePreprocessPendingFiles]);

  const handleImagePreprocessOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setImagePreprocessFiles(null);
      setImagePreprocessPendingFiles([]);
    }
  }, []);

  const onFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) {
      void preprocessAndUpload(files);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [preprocessAndUpload]);

  const handlePaste = useCallback((event: ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    const pastedImages: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          pastedImages.push(new File([file], `screenshot-${timestamp}.png`, { type: file.type }));
        }
      }
    }

    if (pastedImages.length > 0) {
      void preprocessAndUpload(pastedImages);
      return;
    }

    const text = event.clipboardData?.getData('text') ?? '';
    if (/\.(png|jpe?g|webp|gif)$/i.test(text.trim())) {
      setUploadError('Tipp: Dateien aus dem Finder können nicht direkt eingefügt werden. Bitte nutze die Büroklammer zum Hochladen, oder kopiere das Bild direkt (z.B. Screenshot).');
    }
  }, [preprocessAndUpload]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const handleAttachmentPreviewOpen = useCallback((attachment: Attachment, previewGroup?: Attachment[]) => {
    const displayAttachment = deriveUploadAttachmentPreview(attachment);
    const mediaUrl = getAttachmentMediaUrl(displayAttachment);
    if (mediaUrl && onMediaClick) {
      onMediaClick(mediaUrl);
      return;
    }

    const displayGroup = (previewGroup?.length ? previewGroup : [displayAttachment])
      .map((item) => deriveUploadAttachmentPreview(item))
      .filter((item) => item.contentKind === 'image');
    setPreviewAttachment(displayAttachment);
    setPreviewAttachmentGroup(displayGroup.length ? displayGroup : [displayAttachment]);
  }, [onMediaClick]);

  const handleMediaPreviewClick = useCallback((mediaUrl: string) => {
    if (onMediaClick) {
      onMediaClick(mediaUrl);
      return;
    }
    setPreviewAttachment(createImageAttachmentFromMediaUrl(mediaUrl));
    setPreviewAttachmentGroup([]);
  }, [onMediaClick]);

  const handleAttachmentPreviewClose = useCallback(() => {
    setPreviewAttachment(null);
    setPreviewAttachmentGroup([]);
  }, []);

  return {
    attachments,
    fileInputRef,
    handleAttachmentPreviewClose,
    handleAttachmentPreviewOpen,
    handleImagePreprocessConfirm,
    handleImagePreprocessOpenChange,
    handleImagePreprocessSkip,
    handleMediaPreviewClick,
    handlePaste,
    imagePreprocessFiles,
    isUploading,
    onFileChange,
    previewAttachment,
    previewAttachmentGroup,
    removeAttachment,
    setAttachments,
    setUploadError,
    uploadError,
  };
}
