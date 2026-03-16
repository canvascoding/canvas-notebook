'use client';

import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import * as XLSX from 'xlsx';
import { Loader2, AlertCircle } from 'lucide-react';
import jspreadsheet from 'jspreadsheet-ce';

// Import Jspreadsheet styles
import 'jsuites/dist/jsuites.css';
import 'jspreadsheet-ce/dist/jspreadsheet.css';

interface SpreadsheetEditorProps {
  path: string;
  onChange?: () => void;
}

interface SheetData {
  name: string;
  data: (string | number | boolean)[][];
}

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
    const workbookRef = useRef<XLSX.WorkBook | null>(null);
    const formulasRef = useRef<Map<string, string>>(new Map());

    useImperativeHandle(ref, () => ({
      save: async () => {
        if (!workbookRef.current || !jspreadsheetInstanceRef.current) {
          return null;
        }
        return convertToBase64(workbookRef.current, fileExtension);
      },
      getData: () => {
        if (!workbookRef.current) return null;
        return workbookRef.current.SheetNames.map((name, index) => ({
          name,
          data: getSheetData(index),
        }));
      },
      hasChanges: () => hasUnsavedChanges,
    }));

    const getSheetData = (sheetIndex: number): (string | number | boolean)[][] => {
      const instance = jspreadsheetInstanceRef.current;
      if (!instance || !instance.length) return [['']];
      
      // Get the specific worksheet
      const worksheet = instance[sheetIndex];
      if (!worksheet) return [['']];
      
      return worksheet.getData();
    };

    useEffect(() => {
      const extension = path.split('.').pop()?.toLowerCase() || '';
      setFileExtension(extension);

      const loadSpreadsheet = async () => {
        try {
          setIsLoading(true);
          setError(null);
          
          // Fetch file content
          const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`, {
            credentials: 'include'
          });
          
          if (!response.ok) {
            throw new Error(`Failed to load file: ${response.status} ${response.statusText}`);
          }

          const arrayBuffer = await response.arrayBuffer();
          
          // Validate that we got actual data
          if (arrayBuffer.byteLength === 0) {
            throw new Error('File is empty');
          }

          // Check for ZIP magic bytes (PK) for XLSX files
          if (extension !== 'csv') {
            const bytes = new Uint8Array(arrayBuffer.slice(0, 2));
            if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) {
              // Not a valid ZIP/XLSX file - might be corrupted or wrong format
              console.warn('[SpreadsheetEditor] File does not start with ZIP magic bytes, attempting to parse anyway...');
            }
          }

          let sheets: SheetData[] = [];
          formulasRef.current = new Map();

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
            workbookRef.current = null;
          } else {
            // Parse XLSX/XLS with formula support
            const workbook = XLSX.read(arrayBuffer, { 
              type: 'array',
              cellFormula: true,  // Keep formulas
              cellNF: true,       // Keep number formats
              cellStyles: true,   // Keep styles
            });
            
            workbookRef.current = workbook;
            
            // Extract all sheets
            sheets = workbook.SheetNames.map(sheetName => {
              const worksheet = workbook.Sheets[sheetName];
              
              // Get data with formulas
              const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
                header: 1,
                raw: false,  // Get formatted values
              }) as unknown[][];
              
              // Process data and extract formulas
              const processedData = jsonData.map((row, rowIndex) => 
                (row || []).map((cell, colIndex) => {
                  const cellRef = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
                  const cellObj = worksheet[cellRef];
                  
                  // Store formula if present
                  if (cellObj && cellObj.f) {
                    formulasRef.current.set(`${sheetName}!${cellRef}`, cellObj.f);
                    return '=' + cellObj.f;  // Return formula with = prefix for jspreadsheet
                  }
                  
                  // Return value
                  if (cell === null || cell === undefined) return '';
                  if (typeof cell === 'boolean') return cell;
                  if (typeof cell === 'number') return cell;
                  return String(cell);
                })
              );
              
              return {
                name: sheetName,
                data: processedData.length > 0 ? processedData : [['']]
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
              onchange: () => {
                setHasUnsavedChanges(true);
                onChange?.();
              },
              onload: () => {
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
          // jspreadsheet doesn't have a destroy method, but we can clear the container
          if (containerElement) {
            containerElement.innerHTML = '';
          }
          jspreadsheetInstanceRef.current = null;
        }
        workbookRef.current = null;
        formulasRef.current = new Map();
      };
    }, [path, onChange]);

    const convertToBase64 = (workbook: XLSX.WorkBook, extension: string): string => {
      if (extension === 'csv') {
        // For CSV, only export first sheet
        const instance = jspreadsheetInstanceRef.current;
        if (instance && instance.length > 0) {
          const data = instance[0].getData();
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
            const data = worksheet.getData();
            const sheetName = sheetNames[index] || `Sheet${index + 1}`;
            const ws = XLSX.utils.aoa_to_sheet(data);
            
            // Restore formulas from cells that start with =
            data.forEach((row, rowIndex) => {
              row.forEach((cell, colIndex) => {
                const cellStr = String(cell);
                if (cellStr.startsWith('=')) {
                  const cellRef = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
                  if (!ws[cellRef]) ws[cellRef] = {};
                  ws[cellRef].f = cellStr.substring(1);  // Remove = prefix
                }
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
      <div className="flex h-full w-full flex-col bg-background">
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
