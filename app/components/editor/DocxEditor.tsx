'use client';

import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import dynamic from 'next/dynamic';
import type { DocxEditorRef } from '@eigenpal/docx-js-editor';

// Dynamically import the editor to avoid SSR issues
const DocxEditorComponent = dynamic(
  () => import('@eigenpal/docx-js-editor').then((mod) => mod.DocxEditor),
  { ssr: false }
);

// Import styles
import '@eigenpal/docx-js-editor/styles.css';

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
  function DocxEditorWrapper({ path, documentBuffer, onChange, mode = 'editing' }, ref) {
    const editorRef = useRef<DocxEditorRef>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useImperativeHandle(ref, () => ({
      save: async () => {
        if (editorRef.current) {
          return await editorRef.current.save();
        }
        return null;
      },
    }));

    useEffect(() => {
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
      <div className="flex h-full w-full flex-col bg-background">
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
