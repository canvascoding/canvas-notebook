'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { FileText, X, Loader2, Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';

interface ShareMarkdownDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  fileName: string;
}

export function ShareMarkdownDialog({
  open,
  onOpenChange,
  filePath,
  fileName,
}: ShareMarkdownDialogProps) {
  const t = useTranslations('notebook');
  const [loading, setLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [htmlContent, setHtmlContent] = useState<string>('');
  const [error, setError] = useState<string>('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const loadHtmlExport = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch(
        `/api/files/markdown-export?path=${encodeURIComponent(filePath)}`
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(
          errorData?.error || t('failedToExportMarkdown', { statusText: response.statusText })
        );
      }

      const html = await response.text();
      setHtmlContent(html);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('failedToLoadPreview');
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    if (open && filePath) {
      loadHtmlExport();
    } else {
      setHtmlContent('');
      setError('');
    }
  }, [open, filePath, loadHtmlExport]);

  const handleOpenPDF = async () => {
    setPdfLoading(true);
    try {
      const response = await fetch('/api/files/markdown-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(
          errorData?.error || t('pdfGenerationFailed', { statusText: response.statusText })
        );
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('failedToGeneratePdf');
      toast.error(message);
    } finally {
      setPdfLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent layout="viewport" showCloseButton={false} className="flex flex-col sm:max-w-4xl">
        <DialogHeader className="px-4 md:px-6 pt-4 md:pt-5 pb-2 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base md:text-lg">
            <FileText className="h-4 md:h-5 w-4 md:w-5 shrink-0" />
            <span className="truncate min-w-0" title={fileName}>
              {t('shareTitle', { fileName })}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 px-4 md:px-6 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{t('loadingPreview')}</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center px-4">
                <p className="text-red-500 mb-2 text-sm md:text-base">{error}</p>
                <Button variant="outline" onClick={loadHtmlExport} size="sm">
                  {t('tryAgain')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="border rounded-lg overflow-hidden bg-white h-full">
              {htmlContent ? (
                <iframe
                  ref={iframeRef}
                  srcDoc={htmlContent}
                  className="w-full h-full"
                  sandbox="allow-same-origin"
                  title={t('previewTitle', { fileName })}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  {t('noPreviewAvailable')}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 px-4 md:px-6 py-3 md:py-4 border-t bg-muted/50 shrink-0">
          <div className="text-xs md:text-sm text-muted-foreground order-2 sm:order-1">
            {!loading && !error && (
              <span className="flex items-center gap-1">
                <Eye className="h-3 md:h-4 w-3 md:w-4" />
                {t('previewReady')}
              </span>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 order-1 sm:order-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              size="sm"
              className="md:size-default"
            >
              <X className="h-4 w-4 mr-1 md:mr-2" />
              <span>{t('close')}</span>
            </Button>

            <Button
              onClick={handleOpenPDF}
              disabled={loading || pdfLoading || !!error || !htmlContent}
              size="sm"
              className="md:size-default"
            >
              {pdfLoading ? (
                <Loader2 className="h-4 w-4 mr-1 md:mr-2 animate-spin" />
              ) : (
                <FileText className="h-4 w-4 mr-1 md:mr-2" />
              )}
              <span>{pdfLoading ? t('generatingPdf') : t('openAsPdf')}</span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
