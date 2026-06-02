'use client';

import { useState } from 'react';
import { Download, FileImage, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface MarpExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  fileName: string;
}

type ImageFormat = 'png' | 'jpeg';

function getFallbackDownloadName(filePath: string, format: ImageFormat) {
  const rawBaseName = filePath.split(/[\\/]/).filter(Boolean).pop() || 'slides';
  const baseName = rawBaseName
    .replace(/\.(marp|slides)\.(md|markdown)$/i, '')
    .replace(/\.(md|markdown)$/i, '');
  return `${baseName || 'slides'}-${format}-slides.zip`;
}

function getHeaderFileName(headers: Headers): string | null {
  const disposition = headers.get('content-disposition');
  const match = disposition?.match(/filename="([^"]+)"/i);
  return match?.[1] ?? null;
}

export function MarpExportDialog({ open, onOpenChange, filePath, fileName }: MarpExportDialogProps) {
  const t = useTranslations('notebook');
  const [loadingFormat, setLoadingFormat] = useState<ImageFormat | null>(null);

  const handleExport = async (format: ImageFormat) => {
    setLoadingFormat(format);

    try {
      const response = await fetch('/api/files/marp-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, format }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error || t('marpImageExportFailed'));
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = getHeaderFileName(response.headers) || getFallbackDownloadName(filePath, format);
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success(t('marpImageDownloadStarted'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('marpImageExportFailed');
      toast.error(message);
    } finally {
      setLoadingFormat(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileImage className="h-5 w-5" />
            {t('marpExportImagesTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('marpExportImagesDescription', { fileName })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-2 sm:grid-cols-2">
          <Button
            variant="secondary"
            onClick={() => void handleExport('png')}
            disabled={loadingFormat !== null}
            className="justify-start"
          >
            {loadingFormat === 'png' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {t('downloadPngSlides')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleExport('jpeg')}
            disabled={loadingFormat !== null}
            className="justify-start"
          >
            {loadingFormat === 'jpeg' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {t('downloadJpegSlides')}
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loadingFormat !== null}>
            <X className="h-4 w-4" />
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
