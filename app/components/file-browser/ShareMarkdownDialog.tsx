'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Download, FileText, X, Loader2, Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { toHtmlPreviewUrl } from '@/app/lib/utils/media-url';
import { HtmlPreviewBlocked, HtmlPreviewConsent } from '@/app/components/editor/HtmlPreviewConsent';

interface ShareMarkdownDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  fileName: string;
  kind?: 'markdown' | 'html';
}

function getPdfDownloadName(filePath: string) {
  const rawBaseName = filePath.split(/[\\/]/).filter(Boolean).pop() || 'document';
  let decodedBaseName = rawBaseName;

  try {
    decodedBaseName = decodeURIComponent(rawBaseName);
  } catch {
    decodedBaseName = rawBaseName;
  }

  const baseName = decodedBaseName.trim() || 'document';
  const withoutKnownExtension = baseName.replace(/\.(md|mdx|markdown|html|htm)$/i, '');
  return `${withoutKnownExtension || 'document'}.pdf`;
}

export function ShareMarkdownDialog({
  open,
  onOpenChange,
  filePath,
  fileName,
  kind = 'markdown',
}: ShareMarkdownDialogProps) {
  const t = useTranslations('notebook');
  const [loading, setLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [htmlContent, setHtmlContent] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [htmlPreviewAllowed, setHtmlPreviewAllowed] = useState(false);
  const [htmlPreviewDeclined, setHtmlPreviewDeclined] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const loadHtmlExport = useCallback(async () => {
    if (kind === 'html') {
      setLoading(false);
      setError('');
      setHtmlContent('');
      return;
    }

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
  }, [filePath, kind, t]);

  useEffect(() => {
    if (open && filePath) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadHtmlExport();
      setHtmlPreviewAllowed(kind !== 'html');
      setHtmlPreviewDeclined(false);
    } else {
      setHtmlContent('');
      setError('');
      setHtmlPreviewAllowed(false);
      setHtmlPreviewDeclined(false);
    }
  }, [open, filePath, kind, loadHtmlExport]);

  const handleDownloadPDF = async () => {
    setPdfLoading(true);
    try {
      const response = await fetch(kind === 'html' ? '/api/files/html-pdf' : '/api/files/markdown-pdf', {
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
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = getPdfDownloadName(filePath);
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success(t('pdfDownloadStarted'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('failedToGeneratePdf');
      toast.error(message);
    } finally {
      setPdfLoading(false);
    }
  };

  const hasPreview = kind === 'html' || !!htmlContent;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent layout="viewport" showCloseButton={false} className="gap-0">
        <DialogHeader className="px-3 sm:px-5 lg:px-6 pt-3 sm:pt-5 pb-2 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base md:text-lg">
            <FileText className="h-4 md:h-5 w-4 md:w-5 shrink-0" />
            <span className="truncate min-w-0" title={fileName}>
              {t('shareTitle', { fileName })}
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('shareDescription', { fileName })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 px-3 sm:px-5 lg:px-6 pb-3 sm:pb-5 overflow-hidden">
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
            <div className="border rounded-md sm:rounded-lg overflow-hidden bg-white h-full">
              {kind === 'html' ? (
                htmlPreviewAllowed ? (
                  <iframe
                    ref={iframeRef}
                    src={toHtmlPreviewUrl(filePath)}
                    className="w-full h-full"
                    sandbox="allow-scripts allow-same-origin"
                    title={t('previewTitle', { fileName })}
                  />
                ) : (
                  <>
                    <HtmlPreviewBlocked
                      fileName={fileName}
                      onOpen={() => {
                        setHtmlPreviewDeclined(false);
                        setHtmlPreviewAllowed(true);
                      }}
                    />
                    <HtmlPreviewConsent
                      open={!htmlPreviewDeclined}
                      fileName={fileName}
                      onAccept={() => setHtmlPreviewAllowed(true)}
                      onDecline={() => setHtmlPreviewDeclined(true)}
                    />
                  </>
                )
              ) : htmlContent ? (
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

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 px-3 sm:px-5 lg:px-6 py-3 border-t bg-muted/50 shrink-0">
          <div className="text-xs md:text-sm text-muted-foreground order-2 sm:order-1 min-h-4">
            {!loading && !error && (
              <span className="flex items-center gap-1">
                <Eye className="h-3 md:h-4 w-3 md:w-4" />
                {t('previewReady')}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 order-1 sm:order-2 sm:flex sm:items-center sm:justify-end">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              size="sm"
              className="w-full sm:w-auto"
            >
              <X className="h-4 w-4 mr-1 md:mr-2" />
              <span>{t('close')}</span>
            </Button>

            <Button
              onClick={handleDownloadPDF}
              disabled={loading || pdfLoading || !!error || !hasPreview}
              size="sm"
              className="w-full sm:w-auto"
            >
              {pdfLoading ? (
                <Loader2 className="h-4 w-4 mr-1 md:mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-1 md:mr-2" />
              )}
              <span>{pdfLoading ? t('generatingPdf') : t('downloadPdf')}</span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
