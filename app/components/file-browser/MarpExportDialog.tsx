'use client';

import { useEffect, useState } from 'react';
import { Download, FileImage, FileText, Loader2, X } from 'lucide-react';
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
import { workspaceHeaders } from '@/app/lib/files/client';

interface MarpExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  fileName: string;
}

type ImageFormat = 'png' | 'jpeg';
type ExportFormat = ImageFormat | 'pdf';

type BrowserStatusPayload = {
  capability?: {
    browserExportsAvailable?: boolean;
  };
};

function getFallbackDownloadName(filePath: string, format: ExportFormat) {
  const rawBaseName = filePath.split(/[\\/]/).filter(Boolean).pop() || 'slides';
  const baseName = rawBaseName
    .replace(/\.(marp|slides)\.(md|markdown)$/i, '')
    .replace(/\.(md|markdown)$/i, '');

  if (format === 'pdf') {
    return `${baseName || 'slides'}-slides.pdf`;
  }

  return `${baseName || 'slides'}-${format}-slides.zip`;
}

function getHeaderFileName(headers: Headers): string | null {
  const disposition = headers.get('content-disposition');
  const match = disposition?.match(/filename="([^"]+)"/i);
  return match?.[1] ?? null;
}

export function MarpExportDialog({ open, onOpenChange, filePath, fileName }: MarpExportDialogProps) {
  const t = useTranslations('notebook');
  const [loadingFormat, setLoadingFormat] = useState<ExportFormat | null>(null);
  const [browserStatusLoading, setBrowserStatusLoading] = useState(false);
  const [browserExportsAvailable, setBrowserExportsAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;
      setBrowserStatusLoading(true);
      fetch('/api/agents/browser', {
        credentials: 'include',
        cache: 'no-store',
      })
        .then(async (response) => {
          const payload = (await response.json().catch(() => ({}))) as {
            success?: boolean;
            data?: BrowserStatusPayload;
          };
          if (cancelled) return;
          setBrowserExportsAvailable(response.ok && payload.success
            ? payload.data?.capability?.browserExportsAvailable ?? null
            : null);
        })
        .catch(() => {
          if (!cancelled) setBrowserExportsAvailable(null);
        })
        .finally(() => {
          if (!cancelled) setBrowserStatusLoading(false);
        });
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setBrowserExportsAvailable(null);
      setBrowserStatusLoading(false);
    }
    onOpenChange(nextOpen);
  };

  const handleExport = async (format: ExportFormat) => {
    setLoadingFormat(format);

    try {
      const response = await fetch(format === 'pdf' ? '/api/files/marp-pdf' : '/api/files/marp-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
        body: JSON.stringify(format === 'pdf' ? { path: filePath } : { path: filePath, format }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error || t('marpExportFailed'));
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
      toast.success(t('marpDownloadStarted'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('marpExportFailed');
      toast.error(message);
    } finally {
      setLoadingFormat(null);
    }
  };

  const showBrowserExports = browserExportsAvailable !== false;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileImage className="h-5 w-5" />
            {t('marpExportTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('marpExportDescription', { fileName })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-2">
          {showBrowserExports ? (
            <>
              <Button
                variant="secondary"
                onClick={() => void handleExport('pdf')}
                disabled={browserStatusLoading || loadingFormat !== null}
                className="justify-start"
              >
                {loadingFormat === 'pdf' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
                {t('downloadPdfSlides')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void handleExport('png')}
                disabled={browserStatusLoading || loadingFormat !== null}
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
                disabled={browserStatusLoading || loadingFormat !== null}
                className="justify-start"
              >
                {loadingFormat === 'jpeg' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {t('downloadJpegSlides')}
              </Button>
            </>
          ) : (
            <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              {t('browserExportDisabled')}
            </p>
          )}
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
