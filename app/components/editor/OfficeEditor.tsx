'use client';

import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';

// Dynamic import for DocxEditor to avoid SSR issues
const DocxEditorComponent = dynamic(
  () => import('./DocxEditor').then((mod) => mod.DocxEditorWrapper),
  { ssr: false }
);

// Dynamic import for SpreadsheetEditor
const SpreadsheetEditorComponent = dynamic(
  () => import('./SpreadsheetEditor').then((mod) => mod.SpreadsheetEditor),
  { ssr: false }
);

// Dynamic import for PptxViewer
const PptxViewerComponent = dynamic(
  () => import('./PptxViewer').then((mod) => mod.PptxViewer),
  { ssr: false }
);

interface OfficeEditorProps {
  path: string;
  extension: string;
  updateDraft?: (content: string) => void;
  onChange?: () => void;
}

function OfficeDocumentLoadingSkeleton({ path, extension }: { path: string; extension: string }) {
  const t = useTranslations('notebook');
  const fileName = path.split('/').filter(Boolean).pop() || t('loadingPreview');

  return (
    <div data-testid="office-document-loading-skeleton" className="flex h-full w-full flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-foreground">{fileName}</div>
          <div className="text-[11px] text-muted-foreground">
            {t('openingExtension', { extension: extension.toUpperCase() })}
          </div>
        </div>
        <Skeleton className="h-6 w-24" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-5">
        <div className="mx-auto h-full max-w-4xl space-y-5">
          <div className="space-y-3">
            <Skeleton className="h-8 w-2/5" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_180px]">
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[94%]" />
              <Skeleton className="h-4 w-[88%]" />
              <Skeleton className="h-4 w-[96%]" />
              <Skeleton className="h-4 w-[72%]" />
            </div>
            <Skeleton className="hidden h-32 md:block" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-[92%]" />
            <Skeleton className="h-4 w-[84%]" />
          </div>
        </div>
      </div>
    </div>
  );
}

export interface OfficeEditorRef {
  save: () => Promise<string | null>;
  hasChanges: () => boolean;
}

export const OfficeEditor = forwardRef<OfficeEditorRef, OfficeEditorProps>(
  function OfficeEditor({ path, extension, updateDraft, onChange }, ref) {
    const t = useTranslations('notebook');
    const docxEditorRef = useRef<{ save: () => Promise<ArrayBuffer | null> } | null>(null);
    const spreadsheetEditorRef = useRef<{ save: () => Promise<string | null>; getData: () => { name: string; data: (string | number | boolean)[][] }[] | null; hasChanges: () => boolean } | null>(null);
    const [docxFile, setDocxFile] = useState<{
      path: string;
      buffer: ArrayBuffer | null;
      error: string | null;
    } | null>(null);
    const docxBuffer = extension === 'docx' && docxFile?.path === path ? docxFile.buffer : null;
    const error = extension === 'docx' && docxFile?.path === path ? docxFile.error : null;
    const isLoadingDocx = extension === 'docx' && !docxBuffer && !error;

    useImperativeHandle(ref, () => ({
      save: async () => {
        if (extension === 'docx' && docxEditorRef.current) {
          const buffer = await docxEditorRef.current.save();
          if (buffer) {
            const base64 = btoa(
              new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
            );
            return 'base64:' + base64;
          }
        }
        
        if ((extension === 'xlsx' || extension === 'csv' || extension === 'xls') && spreadsheetEditorRef.current) {
          return await spreadsheetEditorRef.current.save();
        }
        
        return null;
      },
      hasChanges: () => {
        if (extension === 'xlsx' || extension === 'csv' || extension === 'xls') {
          return spreadsheetEditorRef.current?.hasChanges() || false;
        }
        return false;
      },
    }));

    // Helper to sync data to editor draft
    const syncToDraft = () => {
      if (extension === 'docx') {
        // Handle DOCX save
        if (docxEditorRef.current && updateDraft) {
          docxEditorRef.current.save().then((buffer) => {
            if (buffer) {
              const base64 = btoa(
                new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
              );
              updateDraft('base64:' + base64);
              onChange?.();
            }
          });
        }
        return;
      }

      if (extension === 'xlsx' || extension === 'csv' || extension === 'xls') {
        // Handle Spreadsheet save
        if (spreadsheetEditorRef.current && updateDraft) {
          spreadsheetEditorRef.current.save().then((content) => {
            if (content) {
              updateDraft(content);
              onChange?.();
            }
          });
        }
        return;
      }
    };

    useEffect(() => {
      if (extension === 'docx') {
        let cancelled = false;
        // Load DOCX file for the new editor
        const loadDocx = async () => {
          try {
            const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`, {
              credentials: 'include'
            });
            if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            if (!cancelled) {
              setDocxFile({ path, buffer: arrayBuffer, error: null });
            }
          } catch (err) {
            console.error('[OfficeEditor] Error loading DOCX:', err);
            if (!cancelled) {
              setDocxFile({
                path,
                buffer: null,
                error: err instanceof Error ? err.message : 'Unknown error',
              });
            }
          }
        };
        void loadDocx();
        return () => {
          cancelled = true;
        };
      }
    }, [path, extension]);

    if (isLoadingDocx) {
      return <OfficeDocumentLoadingSkeleton path={path} extension={extension} />;
    }

    if (error) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-destructive/10 p-4">
          <div className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        </div>
      );
    }

    // Handle DOCX editor
    if (extension === 'docx' && docxBuffer) {
      return (
        <div className="flex flex-col h-full w-full bg-background relative overflow-hidden">
          <div className="absolute top-2 right-12 z-[70] flex gap-2">
            <button 
                onClick={(e) => {
                    e.stopPropagation();
                    syncToDraft();
                }}
                className="border border-border bg-primary px-3 py-1 text-xs text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
                {t('updateChanges')}
            </button>
          </div>
          <DocxEditorComponent
            ref={docxEditorRef}
            path={path}
            documentBuffer={docxBuffer}
            mode="editing"
            onChange={() => {}}
          />
        </div>
      );
    }

    // Handle Spreadsheet editor (XLSX, CSV, XLS)
    if (extension === 'xlsx' || extension === 'csv' || extension === 'xls') {
      return (
        <div className="flex flex-col h-full w-full bg-background relative overflow-hidden">
          <div className="absolute top-2 right-12 z-[70] flex gap-2">
            <button 
                onClick={(e) => {
                    e.stopPropagation();
                    syncToDraft();
                }}
                className="border border-border bg-primary px-3 py-1 text-xs text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
                {t('updateChanges')}
            </button>
          </div>
          <SpreadsheetEditorComponent
            ref={spreadsheetEditorRef}
            path={path}
            onChange={onChange}
          />
        </div>
      );
    }

    // Handle PPTX viewer (read-only)
    if (extension === 'pptx') {
      return (
        <div className="flex flex-col h-full w-full bg-background relative overflow-hidden">
          <PptxViewerComponent
            path={path}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-col h-full w-full bg-background relative overflow-hidden">
        <div className="flex-1 w-full h-full flex items-center justify-center">
          <div className="text-muted-foreground">
            {t('unsupportedFileFormat', { extension })}
          </div>
        </div>
      </div>
    );
  }
);

export default OfficeEditor;
