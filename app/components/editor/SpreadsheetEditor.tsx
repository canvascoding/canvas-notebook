'use client';

import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import * as XLSX from 'xlsx';
import { Loader2 } from 'lucide-react';
import jspreadsheet from 'jspreadsheet-ce';

// Import Jspreadsheet styles
import 'jsuites/dist/jsuites.css';
import 'jspreadsheet-ce/dist/jspreadsheet.css';

interface SpreadsheetEditorProps {
  path: string;
  onChange?: () => void;
}

export interface SpreadsheetEditorRef {
  save: () => Promise<string | null>;
  getData: () => (string | number | boolean)[][] | null;
}

export const SpreadsheetEditor = forwardRef<SpreadsheetEditorRef, SpreadsheetEditorProps>(
  function SpreadsheetEditor({ path, onChange }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const worksheetRef = useRef<ReturnType<typeof jspreadsheet>[number] | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [fileExtension, setFileExtension] = useState<string>('');

    useImperativeHandle(ref, () => ({
      save: async () => {
        if (worksheetRef.current) {
          const data = worksheetRef.current.getData();
          return convertToBase64(data, fileExtension);
        }
        return null;
      },
      getData: () => {
        if (worksheetRef.current) {
          return worksheetRef.current.getData();
        }
        return null;
      },
    }));

    useEffect(() => {
      const extension = path.split('.').pop()?.toLowerCase() || '';
      setFileExtension(extension);

      const loadSpreadsheet = async () => {
        try {
          // Fetch file content
          const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`, {
            credentials: 'include'
          });
          
          if (!response.ok) {
            throw new Error(`Failed to load file: ${response.status}`);
          }

          const arrayBuffer = await response.arrayBuffer();
          let data: (string | number | boolean)[][] = [];

          if (extension === 'csv') {
            // Parse CSV
            const text = new TextDecoder('utf-8').decode(arrayBuffer);
            const rows = text.split('\n').map(row => 
              row.split(',').map(cell => {
                const trimmed = cell.trim();
                // Try to parse as number
                const num = Number(trimmed);
                if (!isNaN(num)) return num;
                // Check for boolean
                if (trimmed.toLowerCase() === 'true') return true;
                if (trimmed.toLowerCase() === 'false') return false;
                return trimmed;
              })
            );
            data = rows;
          } else {
            // Parse XLSX/XLS
            const workbook = XLSX.read(arrayBuffer, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 }) as unknown[][];
            data = jsonData.map(row => row.map(cell => {
              if (cell === null || cell === undefined) return '';
              if (typeof cell === 'boolean') return cell;
              if (typeof cell === 'number') return cell;
              return String(cell);
            }));
          }

          // Ensure data has at least some rows/columns
          if (data.length === 0) {
            data = [['']];
          }

          // Initialize Jspreadsheet
          if (containerRef.current) {
            const worksheets = jspreadsheet(containerRef.current, {
              worksheets: [{
                data: data,
                columns: data[0]?.map(() => ({ width: 100 })) || [{ width: 100 }],
                minDimensions: [10, 10],
              }],
            });

            if (worksheets && worksheets.length > 0) {
              worksheetRef.current = worksheets[0];
            }
            setIsLoading(false);
          }
        } catch (err) {
          console.error('[SpreadsheetEditor] Error:', err);
          setError(err instanceof Error ? err.message : 'Unknown error');
          setIsLoading(false);
        }
      };

      loadSpreadsheet();

      return () => {
        // Cleanup is handled by Jspreadsheet automatically
        worksheetRef.current = null;
      };
    }, [path, onChange]);

    const convertToBase64 = (data: (string | number | boolean)[][], extension: string): string => {
      if (extension === 'csv') {
        // Convert to CSV
        const csv = data.map(row => 
          row.map(cell => {
            // Escape cells with commas or quotes
            const cellStr = String(cell ?? '');
            if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
              return `"${cellStr.replace(/"/g, '""')}"`;
            }
            return cellStr;
          }).join(',')
        ).join('\n');
        return 'base64:' + btoa(unescape(encodeURIComponent(csv)));
      } else {
        // Convert to XLSX
        const ws = XLSX.utils.aoa_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
        return 'base64:' + wbout;
      }
    };

    if (error) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-destructive/10 p-4">
          <div className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
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
          className="flex-1 overflow-auto p-4"
          style={{ minHeight: '400px' }}
        />
      </div>
    );
  }
);

export default SpreadsheetEditor;
