'use client';

import React, { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

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

interface OfficeEditorProps {
  path: string;
  extension: string;
  updateDraft?: (content: string) => void;
}

export function OfficeEditor({ path, extension, updateDraft }: OfficeEditorProps) {
  const docxEditorRef = useRef<{ save: () => Promise<ArrayBuffer | null> } | null>(null);
  const spreadsheetEditorRef = useRef<{ save: () => Promise<string | null>; getData: () => (string | number | boolean)[][] | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [docxBuffer, setDocxBuffer] = useState<ArrayBuffer | null>(null);

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
          }
        });
      }
      return;
    }
  };

  useEffect(() => {
    if (extension === 'docx') {
      // Load DOCX file for the new editor
      const loadDocx = async () => {
        try {
          const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`, {
            credentials: 'include'
          });
          if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
          const arrayBuffer = await response.arrayBuffer();
          setDocxBuffer(arrayBuffer);
          setLoading(false);
        } catch (err) {
          console.error('[OfficeEditor] Error loading DOCX:', err);
          setError(err instanceof Error ? err.message : 'Unknown error');
          setLoading(false);
        }
      };
      loadDocx();
      return;
    }

    // For XLSX/CSV, loading is handled by SpreadsheetEditor component
    setLoading(false);
  }, [path, extension]);

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
              Update Changes
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
              Update Changes
          </button>
        </div>
        <SpreadsheetEditorComponent
          ref={spreadsheetEditorRef}
          path={path}
          onChange={() => {}}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-background relative overflow-hidden">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background z-[60]">
          <div className="flex flex-col items-center gap-2">
            <div className="h-8 w-8 animate-spin border-2 border-primary border-t-transparent"></div>
            <span className="text-xs text-muted-foreground">Opening {extension.toUpperCase()}...</span>
          </div>
        </div>
      )}
      
      {error && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-destructive/10 p-4">
          <div className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        </div>
      )}

      <div className="flex-1 w-full h-full flex items-center justify-center">
        <div className="text-muted-foreground">
          Unsupported file format: {extension}
        </div>
      </div>
    </div>
  );
}
