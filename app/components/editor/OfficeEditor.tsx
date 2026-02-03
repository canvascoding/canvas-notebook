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
}

export function OfficeEditor({ path, extension }: OfficeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<Univer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isInitializing = useRef(false);

  useEffect(() => {
    if (!containerRef.current || isInitializing.current) return;
    isInitializing.current = true;

    // Create a dedicated container element
    const el = document.createElement('div');
    el.className = 'univer-instance-container';
    el.style.height = '100%';
    el.style.width = '100%';
    el.style.position = 'absolute';
    el.style.inset = '0';
    containerRef.current.appendChild(el);

    let alive = true;
    let univer: Univer | null = null;

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
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          
          const cellData: any = {};
          jsonData.forEach((row: any, rIndex: number) => {
            row.forEach((v: any, cIndex: number) => {
              if (!cellData[rIndex]) cellData[rIndex] = {};
              cellData[rIndex][cIndex] = { v, m: String(v) };
            });
          });

          if (!alive) return;

          univer.createUnit(UniverInstanceType.UNIVER_SHEET, {
            id: 'workbook-' + Date.now(),
            name: sheetName,
            sheets: {
              'sheet-1': { 
                id: 'sheet-1', 
                name: sheetName, 
                cellData,
                rowCount: Math.max(jsonData.length + 50, 100),
                columnCount: Math.max((jsonData[0] as any)?.length + 20 || 30, 30),
              }
            }
          });
        } else if (extension === 'docx') {
          // Better text extraction for DOCX
          const result = await mammoth.extractRawText({ arrayBuffer });
          const text = (result.value || '').replace(/\r\n/g, '\r').replace(/\n/g, '\r');

          univer.createUnit(UniverInstanceType.UNIVER_DOC, {
            id: 'doc-' + Date.now(),
            body: { 
                dataStream: text + '\r\n\0',
                paragraphs: [
                    {
                        startIndex: text.length,
                    }
                ]
            }
          });
        }

        if (alive) {
          univerRef.current = univer;
          setLoading(false);
          // Auto-focus the editor area
          setTimeout(() => {
            const canvas = el.querySelector('canvas');
            if (canvas) {
                canvas.focus();
                // Simulating a click to ensure internal focus
                canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            }
          }, 800);
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
      isInitializing.current = false;
      const toDispose = univer;
      const parent = containerRef.current;
      setTimeout(() => {
        try { 
          if (toDispose) toDispose.dispose(); 
          if (parent && parent.contains(el)) parent.removeChild(el);
        } catch (e) {}
      }, 200);
    };
  }, [path, extension]);

  return (
    <div className="flex flex-col h-full w-full bg-[#1e1e1e] relative overflow-hidden">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900 z-[60]">
          <div className="flex flex-col items-center gap-2">
            <div className="h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <span className="text-xs text-slate-400">Opening {extension.toUpperCase()}...</span>
          </div>
        </div>
      )}
      
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-950/10 z-50 p-4">
          <div className="text-red-400 text-sm border border-red-500/20 bg-red-500/5 p-3 rounded-lg">
            {error}
          </div>
        </div>
      )}

      <div 
        ref={containerRef} 
        className="flex-1 w-full h-full relative"
        style={{ minHeight: '500px' }}
      />

      <style jsx global>{`
        .univer-instance-container {
          background: #1e1e1e;
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