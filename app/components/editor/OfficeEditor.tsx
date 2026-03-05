'use client';

import React, { useEffect, useRef, useState } from 'react';
import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/docs-ui/lib/index.css';
import '@univerjs/sheets-ui/lib/index.css';

import { Univer, UniverInstanceType, LocaleType } from '@univerjs/core';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverUIPlugin } from '@univerjs/ui';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui';
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt';
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter';
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation';
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting';
import { UniverSheetsZenEditorPlugin } from '@univerjs/sheets-zen-editor';

import * as XLSX from 'xlsx';
import mammoth from 'mammoth';

// Locale imports
import enUS from '@univerjs/design/locale/en-US';
import uiEnUS from '@univerjs/ui/locale/en-US';
import docsUIEnUS from '@univerjs/docs-ui/locale/en-US';
import sheetsEnUS from '@univerjs/sheets/locale/en-US';
import sheetsUIEnUS from '@univerjs/sheets-ui/locale/en-US';

import { defaultTheme } from '@univerjs/design';

interface OfficeEditorProps {
  path: string;
  extension: string;
  updateDraft?: (content: string) => void;
}

interface SheetCell {
  v?: unknown;
  m?: string;
}

type SheetRow = Record<string, SheetCell>;

interface SheetSnapshot {
  name?: string;
  cellData?: Record<string, SheetRow>;
}

interface WorkbookSnapshot {
  sheets: Record<string, SheetSnapshot>;
}

interface WorkbookUnit {
  save: () => WorkbookSnapshot;
}

type UniverLike = Univer & {
  getUniverInstance?: (type: UniverInstanceType) => WorkbookUnit | null;
  __getInjector?: () => unknown;
};

export function OfficeEditor({ path, extension, updateDraft }: OfficeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<Univer | null>(null);
  const isInitialized = useRef(false); // New flag to track if Univer has been initialized
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Helper to sync Univer data to editor draft
  const syncToDraft = () => {
    if (!univerRef.current || !updateDraft || extension !== 'xlsx') return;
    
    try {
        const univer = univerRef.current as UniverLike;
        const injector = univer.__getInjector?.() as
          | {
              get?: (service: string) => {
                getUnit?: (type: UniverInstanceType) => WorkbookUnit | null;
              } | undefined;
            }
          | undefined;
        const workbook =
          univer.getUniverInstance?.(UniverInstanceType.UNIVER_SHEET) ??
          injector?.get?.('IUniverInstanceService')?.getUnit?.(UniverInstanceType.UNIVER_SHEET);
        if (!workbook) return;

        const snapshot = workbook.save();
        const sheet = snapshot.sheets['sheet-1'];
        if (!sheet || !sheet.cellData) return;

        // Convert Univer cellData back to XLSX format
        const data: unknown[][] = [];
        Object.entries(sheet.cellData).forEach(([rStr, row]) => {
            const r = parseInt(rStr);
            if (!data[r]) data[r] = [];
            Object.entries(row).forEach(([cStr, cell]) => {
                const c = parseInt(cStr);
                data[r][c] = cell.v;
            });
        });

        const ws = XLSX.utils.aoa_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, sheet.name || 'Sheet1');
        
        const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
        updateDraft('base64:' + wbout);
    } catch (e) {
        console.error('[OfficeEditor] Sync error:', e);
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // Use the isInitialized ref to prevent multiple initializations in StrictMode
    if (isInitialized.current) {
      return;
    }

    isInitialized.current = true; // Mark as initialized for this component instance

    // Use a local variable to track if this effect instance is still "alive"
    let alive = true;
    let univer: Univer | null = null;
    const parent = containerRef.current;

    // Create a dedicated container element
    const el = document.createElement('div');
    el.className = 'univer-instance-container';
    el.style.height = '100%';
    el.style.width = '100%';
    el.style.position = 'absolute';
    el.style.inset = '0';
    parent.appendChild(el);

    const init = async () => {
      try {
        console.log('[OfficeEditor] Initializing for:', path);
        
        univer = new Univer({
          theme: defaultTheme,
          locale: LocaleType.EN_US,
          locales: {
            [LocaleType.EN_US]: {
              ...enUS,
              ...uiEnUS,
              ...docsUIEnUS,
              ...sheetsEnUS,
              ...sheetsUIEnUS,
            },
          },
        });

        // Register core plugins
        univer.registerPlugin(UniverRenderEnginePlugin);
        univer.registerPlugin(UniverFormulaEnginePlugin);
        univer.registerPlugin(UniverUIPlugin, {
          container: el,
          header: true,
          footer: true,
        });

        // Global registration for input capture
        univer.registerPlugin(UniverDocsPlugin);
        univer.registerPlugin(UniverDocsUIPlugin);

        // Fetch file data with credentials
        const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`, {
            credentials: 'include'
        });
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        
        if (!alive) {
            univer.dispose();
            return;
        }

        if (extension === 'xlsx' || extension === 'csv') {
          univer.registerPlugin(UniverSheetsPlugin);
          univer.registerPlugin(UniverSheetsUIPlugin);
          univer.registerPlugin(UniverSheetsFormulaPlugin);
          univer.registerPlugin(UniverSheetsNumfmtPlugin);
          univer.registerPlugin(UniverSheetsFilterPlugin);
          univer.registerPlugin(UniverSheetsDataValidationPlugin);
          univer.registerPlugin(UniverSheetsConditionalFormattingPlugin);
          univer.registerPlugin(UniverSheetsZenEditorPlugin);

          const workbook = XLSX.read(arrayBuffer, { type: 'array' });
          const sheetName = workbook.SheetNames[0] || 'Sheet1';
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as unknown[][];
          
          const cellData: Record<number, Record<number, { v: unknown; m: string }>> = {};
          jsonData.forEach((row, rIndex: number) => {
            row.forEach((v, cIndex: number) => {
              if (!cellData[rIndex]) cellData[rIndex] = {};
              cellData[rIndex][cIndex] = { v, m: String(v) };
            });
          });
          const firstRowLength = Array.isArray(jsonData[0]) ? jsonData[0].length : 0;

          if (!alive) return;

          univer.createUnit(UniverInstanceType.UNIVER_SHEET, {
            id: 'workbook-instance',
            name: sheetName,
            sheets: {
              'sheet-1': { 
                id: 'sheet-1', 
                name: sheetName, 
                cellData,
                rowCount: Math.max(jsonData.length + 50, 100),
                columnCount: Math.max(firstRowLength + 20, 30),
              }
            }
          });
        } else if (extension === 'docx') {
          // Better text extraction for DOCX
          const result = await mammoth.extractRawText({ arrayBuffer });
          const text = (result.value || '').replace(/\r\n/g, '\r').replace(/\n/g, '\r');
          
          // Split into paragraphs for better rendering and scrolling
          const lines = text.split('\r');
          const paragraphs = [];
          let currentPos = 0;
          
          for (const line of lines) {
            currentPos += line.length + 1;
            paragraphs.push({
              startIndex: currentPos - 1,
            });
          }

          univer.createUnit(UniverInstanceType.UNIVER_DOC, {
            id: 'doc-instance',
            body: { 
                dataStream: text + '\r',
                paragraphs: paragraphs
            }
          });
        }

        if (alive) {
          univerRef.current = univer;
          setLoading(false);
          // Auto-focus the editor area
          setTimeout(() => {
            if (!alive) return;
            const canvas = el.querySelector('canvas');
            if (canvas) {
                canvas.focus();
                // Simulating a click to ensure internal focus
                canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            }
          }, 500);
        }
      } catch (err) {
        console.error('[OfficeEditor] Error:', err);
        if (alive) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setLoading(false);
        }
      }
    };

    init();

    return () => {
      alive = false;
      const toDispose = univer;
      if (toDispose) {
        try { 
          setTimeout(() => {
            toDispose.dispose();
          }, 0); 
        } catch (e) {
          console.error('[OfficeEditor] Error disposing Univer instance:', e);
        }
      } else {
      }
      if (parent && parent.contains(el)) {
        parent.removeChild(el);
      }
    };
  }, [path, extension]);

  return (
    <div className="flex flex-col h-full w-full bg-background relative overflow-hidden">
      {/* Header for Save Button */}
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

      <div 
        ref={containerRef} 
        className="flex-1 w-full h-full relative"
      />

      <style jsx global>{`
        .univer-instance-container {
          background: var(--background);
          position: absolute;
          inset: 0;
          overflow: hidden;
        }
        .univer-app-container {
          width: 100% !important;
          height: 100% !important;
          display: flex !important;
          flex-direction: column !important;
        }
        .univer-workbench {
          flex: 1 !important;
          display: flex !important;
          flex-direction: column !important;
        }
        canvas {
          display: block !important;
          outline: none;
        }
      `}</style>
    </div>
  );
}
