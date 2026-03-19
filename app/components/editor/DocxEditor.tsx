'use client';

import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import dynamic from 'next/dynamic';
import type { DocxEditorRef } from '@eigenpal/docx-js-editor/react';

// Dynamically import the editor to avoid SSR issues
const DocxEditorComponent = dynamic(
  () => import('@eigenpal/docx-js-editor/react').then((mod) => mod.DocxEditor),
  { ssr: false }
);

// Import styles
import '@eigenpal/docx-js-editor/styles.css';

// Additional table styles to improve rendering
const tableStyles = `
  .docx-editor table {
    border-collapse: collapse !important;
    width: 100% !important;
    margin: 8px 0 !important;
  }
  
  .docx-editor table td,
  .docx-editor table th {
    border: 1px solid #ccc !important;
    padding: 6px 8px !important;
    min-width: 40px !important;
    vertical-align: top !important;
  }
  
  .docx-editor table th {
    background-color: #f5f5f5 !important;
    font-weight: 600 !important;
  }
  
  .docx-editor table tr:nth-child(even) {
    background-color: #fafafa !important;
  }
  
  .docx-editor table tr:hover {
    background-color: #f0f0f0 !important;
  }
  
  /* Ensure table cells don't overflow */
  .docx-editor table td > *,
  .docx-editor table th > * {
    max-width: 100% !important;
    overflow-wrap: break-word !important;
    word-wrap: break-word !important;
  }
  
  /* Fix for nested tables */
  .docx-editor table table {
    margin: 4px 0 !important;
  }
  
  /* Ensure proper spacing in table cells */
  .docx-editor table p {
    margin: 0 !important;
    padding: 2px 0 !important;
  }
`;

interface DocxEditorWrapperProps {
  path: string;
  documentBuffer: ArrayBuffer;
  onChange?: () => void;
  mode?: 'editing' | 'viewing';
}

export interface DocxEditorWrapperRef {
  save: () => Promise<ArrayBuffer | null>;
}

export const DocxEditorWrapper = forwardRef<DocxEditorWrapperRef, DocxEditorWrapperProps>(
  function DocxEditorWrapper({ documentBuffer, onChange, mode = 'editing' }, ref) {
    const editorRef = useRef<DocxEditorRef>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error] = useState<string | null>(null);

    useImperativeHandle(ref, () => ({
      save: async () => {
        if (editorRef.current) {
          return await editorRef.current.save();
        }
        return null;
      },
    }));

    useEffect(() => {
      // Inject table styles
      const styleId = 'docx-editor-table-styles';
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = tableStyles;
        document.head.appendChild(style);
      }
      
      // Small delay to ensure styles are loaded
      const timer = setTimeout(() => {
        setIsLoading(false);
      }, 100);
      return () => clearTimeout(timer);
    }, []);

    const handleChange = () => {
      if (onChange) {
        onChange();
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
      <div className="docx-editor flex h-full w-full flex-col bg-background">
        {isLoading && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background">
            <div className="flex flex-col items-center gap-2">
              <div className="h-8 w-8 animate-spin border-2 border-primary border-t-transparent"></div>
              <span className="text-xs text-muted-foreground">Loading DOCX editor...</span>
            </div>
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          <DocxEditorComponent
            ref={editorRef}
            documentBuffer={documentBuffer}
            mode={mode}
            onChange={handleChange}
          />
        </div>
      </div>
    );
  }
);

export default DocxEditorWrapper;
