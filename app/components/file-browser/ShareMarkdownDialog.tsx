'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { FileText, X, Download, Loader2, Eye } from 'lucide-react';
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
  const [loading, setLoading] = useState(false);
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
          errorData?.error || `Failed to export markdown: ${response.statusText}`
        );
      }
      
      const html = await response.text();
      setHtmlContent(html);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load preview';
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
      // Reset state when dialog closes
      setHtmlContent('');
      setError('');
    }
  }, [open, filePath, loadHtmlExport]);

  const handleSaveAsPDF = () => {
    if (!htmlContent) return;

    // Create a new window with the HTML content
    const printWindow = window.open('', '_blank', 'width=800,height=600');
    if (!printWindow) {
      toast.error('Could not open print window. Please allow popups.');
      return;
    }

    // Write the HTML content
    printWindow.document.write(htmlContent);
    printWindow.document.close();

    // Wait for images to load, then trigger print
    setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 500);

    toast.success('PDF export dialog opened');
  };

  const getBlobUrl = () => {
    if (!htmlContent) return '';
    const blob = new Blob([htmlContent], { type: 'text/html' });
    return URL.createObjectURL(blob);
  };

  const blobUrl = htmlContent ? getBlobUrl() : '';

  // Cleanup blob URL when component unmounts
  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] md:max-w-4xl max-h-[95vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 md:px-6 pt-4 md:pt-6 pb-2 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base md:text-lg">
            <FileText className="h-4 md:h-5 w-4 md:w-5 shrink-0" />
            <span className="truncate min-w-0" title={fileName}>
              Share: {fileName}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 px-4 md:px-6 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-64 md:h-96">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Loading preview...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-64 md:h-96">
              <div className="text-center px-4">
                <p className="text-red-500 mb-2 text-sm md:text-base">{error}</p>
                <Button variant="outline" onClick={loadHtmlExport} size="sm" className="md:size-default">
                  Try Again
                </Button>
              </div>
            </div>
          ) : (
            <div className="border rounded-lg overflow-hidden bg-white h-64 md:h-[500px]">
              {blobUrl ? (
                <iframe
                  ref={iframeRef}
                  src={blobUrl}
                  className="w-full h-full"
                  sandbox="allow-same-origin"
                  title={`Preview of ${fileName}`}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  No preview available
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
                Preview ready
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
              <span className="hidden sm:inline">Close</span>
              <span className="sm:hidden">Close</span>
            </Button>
            
            <Button
              onClick={handleSaveAsPDF}
              disabled={loading || !!error || !htmlContent}
              size="sm"
              className="md:size-default"
            >
              <Download className="h-4 w-4 mr-1 md:mr-2" />
              <span className="hidden sm:inline">Save as PDF</span>
              <span className="sm:hidden">PDF</span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
