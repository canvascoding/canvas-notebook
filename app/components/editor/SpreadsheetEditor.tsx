'use client';

import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import * as XLSX from 'xlsx';
import { Loader2, AlertCircle } from 'lucide-react';
import jspreadsheet from 'jspreadsheet-ce';

// Import Jspreadsheet styles
import 'jsuites/dist/jsuites.css';
import 'jspreadsheet-ce/dist/jspreadsheet.css';
import './spreadsheet-editor.css';

interface SpreadsheetEditorProps {
  path: string;
  onChange?: () => void;
}

interface SheetData {
  name: string;
  data: (string | number | boolean)[][];
}

type SpreadsheetCellValue = string | number | boolean;

export interface SpreadsheetEditorRef {
  save: () => Promise<string | null>;
  getData: () => SheetData[] | null;
  hasChanges: () => boolean;
}

export const SpreadsheetEditor = forwardRef<SpreadsheetEditorRef, SpreadsheetEditorProps>(
  function SpreadsheetEditor({ path, onChange }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const jspreadsheetInstanceRef = useRef<ReturnType<typeof jspreadsheet> | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [fileExtension, setFileExtension] = useState<string>('');
    const [sheetNames, setSheetNames] = useState<string[]>([]);
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

    useImperativeHandle(ref, () => ({
      save: async () => {
        if (!jspreadsheetInstanceRef.current) {
          return null;
        }
        return convertToBase64(fileExtension);
      },
      getData: () => {
        const instance = jspreadsheetInstanceRef.current;
        if (!instance) return null;
        return instance.map((worksheet, index) => ({
          name: sheetNames[index] || `Sheet${index + 1}`,
          data: getSheetData(index),
        }));
      },
      hasChanges: () => hasUnsavedChanges,
    }), [fileExtension, hasUnsavedChanges, sheetNames]);

    const getSheetData = (sheetIndex: number): SpreadsheetCellValue[][] => {
      const instance = jspreadsheetInstanceRef.current;
      if (!instance || !instance.length) return [['']];
      
      // Get the specific worksheet
      const worksheet = instance[sheetIndex];
      if (!worksheet) return [['']];
      
      return worksheet.getData(false, false) as SpreadsheetCellValue[][];
    };

    const extractWorksheetData = (worksheet: XLSX.WorkSheet): SpreadsheetCellValue[][] => {
      const rangeRef = worksheet['!ref'] || 'A1:A1';
      const range = XLSX.utils.decode_range(rangeRef);
      const rowCount = Math.max(range.e.r - range.s.r + 1, 1);
      const columnCount = Math.max(range.e.c - range.s.c + 1, 1);

      const data = Array.from({ length: rowCount }, () =>
        Array.from({ length: columnCount }, () => '' as SpreadsheetCellValue)
      );

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        for (let colIndex = 0; colIndex < columnCount; colIndex += 1) {
          const cellRef = XLSX.utils.encode_cell({
            r: range.s.r + rowIndex,
            c: range.s.c + colIndex,
          });
          const cell = worksheet[cellRef];

          if (!cell) {
            continue;
          }

          if (cell.f) {
            data[rowIndex][colIndex] = `=${cell.f}`;
            continue;
          }

          if (cell.t === 'b') {
            data[rowIndex][colIndex] = Boolean(cell.v);
            continue;
          }

          if (typeof cell.v === 'number') {
            data[rowIndex][colIndex] = cell.v;
            continue;
          }

          data[rowIndex][colIndex] = String(cell.w ?? cell.v ?? '');
        }
      }

      return data;
    };

    const normalizeProcessedValue = (value: unknown): string | number | boolean | undefined => {
      if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
      }

      if (typeof value !== 'string') {
        return undefined;
      }

      const trimmed = value.trim();
      if (!trimmed) {
        return '';
      }

      if (trimmed.toLowerCase() === 'true') {
        return true;
      }

      if (trimmed.toLowerCase() === 'false') {
        return false;
      }

      const numericValue = Number(trimmed);
      if (!Number.isNaN(numericValue) && /^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
        return numericValue;
      }

      return trimmed;
    };

    useEffect(() => {
      const extension = path.split('.').pop()?.toLowerCase() || '';
      setFileExtension(extension);

      const loadSpreadsheet = async () => {
        try {
          setIsLoading(true);
          setError(null);
          
          console.log('[SpreadsheetEditor] Loading file:', path);
          
          // Fetch file content
          const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`, {
            credentials: 'include'
          });
          
          console.log('[SpreadsheetEditor] Response status:', response.status, response.statusText);
          console.log('[SpreadsheetEditor] Content-Type:', response.headers.get('content-type'));
          
          if (!response.ok) {
            const errorText = await response.text();
            console.error('[SpreadsheetEditor] API Error response:', errorText);
            throw new Error(`Failed to load file: ${response.status} ${response.statusText}`);
          }

          const arrayBuffer = await response.arrayBuffer();
          
          console.log('[SpreadsheetEditor] ArrayBuffer size:', arrayBuffer.byteLength);
          
          // Validate that we got actual data
          if (arrayBuffer.byteLength === 0) {
            throw new Error('File is empty');
          }

          // Check for ZIP magic bytes (PK) for XLSX files
          if (extension !== 'csv') {
            const bytes = new Uint8Array(arrayBuffer.slice(0, 10));
            console.log('[SpreadsheetEditor] File magic bytes:', Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' '));
            
            // XLSX files start with PK (0x50 0x4B)
            // XLS files start with D0 CF 11 E0 A1 B1 1A E1
            const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B;
            const isXls = bytes[0] === 0xD0 && bytes[1] === 0xCF;
            
            if (!isZip && !isXls) {
              console.warn('[SpreadsheetEditor] File does not appear to be a valid XLSX or XLS file. First bytes:', 
                Array.from(bytes.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' '));
            } else {
              console.log('[SpreadsheetEditor] Valid file format detected:', isZip ? 'XLSX (ZIP)' : 'XLS (CFB)');
            }
          }

          let sheets: SheetData[] = [];

          if (extension === 'csv') {
            // Parse CSV
            const text = new TextDecoder('utf-8').decode(arrayBuffer);
            const rows = text.split('\n').filter(row => row.trim()).map(row => 
              row.split(',').map(cell => {
                const trimmed = cell.trim();
                // Try to parse as number
                const num = Number(trimmed);
                if (!isNaN(num) && trimmed !== '') return num;
                // Check for boolean
                if (trimmed.toLowerCase() === 'true') return true;
                if (trimmed.toLowerCase() === 'false') return false;
                return trimmed;
              })
            );
            sheets = [{ name: 'Sheet1', data: rows.length > 0 ? rows : [['']] }];
          } else {
            // Parse XLSX/XLS and keep formulas so the grid can recalculate them.
            const workbook = XLSX.read(arrayBuffer, { 
              type: 'array',
              cellFormula: true,  // Keep formulas
              cellNF: true,       // Keep number formats
              cellStyles: true,   // Keep styles
            });
            
            // Extract all sheets
            sheets = workbook.SheetNames.map(sheetName => {
              const worksheet = workbook.Sheets[sheetName];
              
              return {
                name: sheetName,
                data: extractWorksheetData(worksheet)
              };
            });
          }

          setSheetNames(sheets.map(s => s.name));
          
          // Initialize Jspreadsheet with all worksheets
          if (containerRef.current) {
            // Clear any existing content
            containerRef.current.innerHTML = '';
            
            const worksheets = sheets.map(sheet => ({
              data: sheet.data,
              columns: sheet.data[0]?.map(() => ({ width: 100 })) || [{ width: 100 }],
              minDimensions: [10, 10] as [number, number],
              name: sheet.name,
            }));
            
            const instance = jspreadsheet(containerRef.current, {
              worksheets: worksheets,
              parseFormulas: true,
              tabs: sheets.length > 1,
              onchange: () => {
                setHasUnsavedChanges(true);
                onChange?.();
              },
              onload: () => {
                setHasUnsavedChanges(false);
                setIsLoading(false);
              },
            });

            jspreadsheetInstanceRef.current = instance;
          }
        } catch (err) {
          console.error('[SpreadsheetEditor] Error:', err);
          setError(err instanceof Error ? err.message : 'Unknown error loading file');
          setIsLoading(false);
        }
      };

      loadSpreadsheet();

      // Store ref value in a variable for the cleanup function
      const containerElement = containerRef.current;

      return () => {
        // Cleanup
        if (jspreadsheetInstanceRef.current) {
          if (containerElement) {
            jspreadsheet.destroy(containerElement as Parameters<typeof jspreadsheet.destroy>[0], true);
          }
          jspreadsheetInstanceRef.current = null;
        }
      };
    }, [path, onChange]);

    const convertToBase64 = (extension: string): string => {
      if (extension === 'csv') {
        // For CSV, only export first sheet
        const instance = jspreadsheetInstanceRef.current;
        if (instance && instance.length > 0) {
          const data = instance[0].getData(false, true) as SpreadsheetCellValue[][];
          const csv = data.map(row => 
            row.map(cell => {
              const cellStr = String(cell ?? '');
              if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
                return `"${cellStr.replace(/"/g, '""')}"`;
              }
              return cellStr;
            }).join(',')
          ).join('\n');
          return 'base64:' + btoa(unescape(encodeURIComponent(csv)));
        }
        return 'base64:';
      } else {
        // For XLSX, preserve all sheets and formulas
        const newWorkbook = XLSX.utils.book_new();
        const instance = jspreadsheetInstanceRef.current;
        
        if (instance) {
          instance.forEach((worksheet, index) => {
            const sheetName = sheetNames[index] || `Sheet${index + 1}`;
            const rawData = worksheet.getData(false, false) as SpreadsheetCellValue[][];
            const ws = XLSX.utils.aoa_to_sheet(rawData);

            rawData.forEach((row, rowIndex) => {
              row.forEach((cell, colIndex) => {
                if (typeof cell !== 'string' || !cell.startsWith('=')) {
                  return;
                }

                const cellRef = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
                const processedValue = normalizeProcessedValue(worksheet.getValueFromCoords(colIndex, rowIndex, true));

                ws[cellRef] = {
                  ...(processedValue !== undefined ? XLSX.utils.aoa_to_sheet([[processedValue]])['A1'] : {}),
                  f: cell.slice(1),
                };
              });
            });
            
            XLSX.utils.book_append_sheet(newWorkbook, ws, sheetName);
          });
        }
        
        const wbout = XLSX.write(newWorkbook, { type: 'base64', bookType: 'xlsx' });
        return 'base64:' + wbout;
      }
    };

    if (error) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-destructive/10 p-4">
          <div className="border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive max-w-md">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="h-5 w-5" />
              <span className="font-semibold">Error loading spreadsheet</span>
            </div>
            <p>{error}</p>
            <p className="mt-2 text-xs opacity-80">
              File: {path}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="spreadsheet-editor-shell flex h-full w-full flex-col bg-background">
        {isLoading && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="text-xs text-muted-foreground">Loading spreadsheet...</span>
            </div>
          </div>
        )}
        <div 
          ref={containerRef} 
          className="flex-1 overflow-auto"
          style={{ minHeight: '400px' }}
        />
      </div>
    );
  }
);

export default SpreadsheetEditor;
