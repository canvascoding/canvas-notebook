'use client';

import React, { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { DocumentLoadingSkeleton } from './DocumentLoadingSkeleton';
import { workspaceDownloadUrl, workspaceHeaders } from '@/app/lib/files/client';

// Dynamic import for DocxEditor to avoid SSR issues
const DocxEditorComponent = dynamic(
  () => import('./DocxEditor').then((mod) => mod.DocxEditorWrapper),
  { ssr: false, loading: () => <OfficeModuleLoadingSkeleton /> }
);

// Dynamic import for SpreadsheetEditor
const SpreadsheetEditorComponent = dynamic(
  () => import('./SpreadsheetEditor').then((mod) => mod.SpreadsheetEditor),
  { ssr: false, loading: () => <OfficeModuleLoadingSkeleton /> }
);

// Dynamic import for PptxViewer
const PptxViewerComponent = dynamic(
  () => import('./PptxViewer').then((mod) => mod.PptxViewer),
  { ssr: false, loading: () => <OfficeModuleLoadingSkeleton /> }
);

function OfficeModuleLoadingSkeleton() {
  const t = useTranslations('notebook');
  return <DocumentLoadingSkeleton label={t('loadingPreview')} />;
}

interface OfficeEditorProps {
  path: string;
  extension: string;
  updateDraft?: (content: string) => void;
  onChange?: () => void;
  readOnly?: boolean;
  sourceUrl?: string;
  sourceData?: ArrayBuffer;
  preserveSnapshot?: boolean;
  contentRevision?: string;
}

function OfficeDocumentLoadingSkeleton({ path, extension }: { path: string; extension: string }) {
  const t = useTranslations('notebook');
  return <DocumentLoadingSkeleton path={path} label={t('openingExtension', { extension: extension.toUpperCase() })} />;
}

export interface OfficeEditorRef {
  save: () => Promise<string | null>;
  hasChanges: () => boolean;
  changeVersion: () => number;
  markSaved: (version: number) => void;
}

export const OfficeEditor = forwardRef<OfficeEditorRef, OfficeEditorProps>(
  function OfficeEditor({ path: currentPath, extension, updateDraft, onChange, readOnly = false, sourceUrl: currentSourceUrl, sourceData: currentSourceData, preserveSnapshot = false, contentRevision }, ref) {
    const dirtyRef = useRef(false);
    const changeVersionRef = useRef(0);
    const [hasLocalChanges, setHasLocalChanges] = useState(false);
    const onChangeRef = useRef(onChange);
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    const handleSpreadsheetChange = useCallback(() => {
      dirtyRef.current = true;
      setHasLocalChanges(true);
      changeVersionRef.current += 1;
      onChangeRef.current?.();
    }, []);
    const [snapshot, setSnapshot] = useState(() => ({ path: currentPath, sourceUrl: currentSourceUrl, sourceData: currentSourceData, revision: contentRevision }));
    if (preserveSnapshot && snapshot.revision !== contentRevision && !hasLocalChanges) {
      setSnapshot({ path: currentPath, sourceUrl: currentSourceUrl, sourceData: currentSourceData, revision: contentRevision });
    }
    const path = preserveSnapshot ? snapshot.path : currentPath;
    const sourceUrl = preserveSnapshot ? snapshot.sourceUrl : currentSourceUrl;
    const sourceData = preserveSnapshot ? snapshot.sourceData : currentSourceData;
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
      changeVersion: () => changeVersionRef.current,
      markSaved: (version) => { if (version === changeVersionRef.current) { dirtyRef.current = false; setHasLocalChanges(false); } },
      hasChanges: () => {
        if (dirtyRef.current) return true;
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
            let arrayBuffer = sourceData?.slice(0);
            if (!arrayBuffer) {
              const fetchOptions: RequestInit = { credentials: 'include' };
              if (!sourceUrl) fetchOptions.headers = workspaceHeaders();
              const response = await fetch(sourceUrl ?? workspaceDownloadUrl(path), fetchOptions);
              if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
              arrayBuffer = await response.arrayBuffer();
            }
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
    }, [path, extension, sourceUrl, sourceData]);

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
          {!readOnly && (
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
          )}
          <DocxEditorComponent
            ref={docxEditorRef}
            path={path}
            documentBuffer={docxBuffer}
            mode={readOnly ? 'viewing' : 'editing'}
            onChange={() => { dirtyRef.current = true; setHasLocalChanges(true); changeVersionRef.current += 1; onChange?.(); }}
          />
        </div>
      );
    }

    // Handle Spreadsheet editor (XLSX, CSV, XLS)
    if (extension === 'xlsx' || extension === 'csv' || extension === 'xls') {
      return (
        <div className="flex flex-col h-full w-full bg-background relative overflow-hidden">
          {!readOnly && (
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
          )}
          <SpreadsheetEditorComponent
            ref={spreadsheetEditorRef}
            path={path}
            onChange={handleSpreadsheetChange}
            readOnly={readOnly}
            sourceUrl={sourceUrl}
            sourceData={sourceData}
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
            sourceUrl={sourceUrl}
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
