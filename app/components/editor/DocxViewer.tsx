'use client';

import React, { useEffect, useState } from 'react';
import mammoth from 'mammoth';
import { Loader2, AlertCircle } from 'lucide-react';

interface DocxViewerProps {
  path: string;
}

export function DocxViewer({ path }: DocxViewerProps) {
  const [html, setHtml] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    const loadDocx = async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`, {
          credentials: 'include'
        });
        
        if (!response.ok) throw new Error(`Failed to fetch document: ${response.status}`);
        
        const arrayBuffer = await response.arrayBuffer();
        
        // Convert docx to HTML with Mammoth
        const result = await mammoth.convertToHtml({ arrayBuffer });
        
        if (alive) {
          setHtml(result.value);
          setLoading(false);
          if (result.messages.length > 0) {
            console.warn('[DocxViewer] Mammoth messages:', result.messages);
          }
        }
      } catch (err) {
        console.error('[DocxViewer] Error:', err);
        if (alive) {
          setError(err instanceof Error ? err.message : 'Failed to load document');
          setLoading(false);
        }
      }
    };

    loadDocx();

    return () => {
      alive = false;
    };
  }, [path]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">Rendering document...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-4">
        <div className="flex max-w-md flex-col items-center gap-2 text-center text-sm text-destructive">
          <AlertCircle className="h-8 w-8" />
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="custom-scrollbar h-full w-full overflow-auto bg-muted/40">
      <div className="docx-content mx-auto my-8 min-h-[calc(100%-4rem)] max-w-[850px] border border-border bg-white p-12 text-black shadow-sm">
        <style jsx global>{`
          .docx-content h1 { font-size: 2em; font-weight: bold; margin-bottom: 0.5em; }
          .docx-content h2 { font-size: 1.5em; font-weight: bold; margin-top: 1em; margin-bottom: 0.5em; }
          .docx-content h3 { font-size: 1.25em; font-weight: bold; margin-top: 1em; margin-bottom: 0.5em; }
          .docx-content p { margin-bottom: 1em; line-height: 1.6; }
          .docx-content table { width: 100%; border-collapse: collapse; margin-bottom: 1em; }
          .docx-content table, .docx-content th, .docx-content td { border: 1px solid var(--border); padding: 8px; }
          .docx-content ul, .docx-content ol { margin-bottom: 1em; padding-left: 2em; }
          .docx-content li { margin-bottom: 0.5em; }
          .docx-content img { max-width: 100%; height: auto; }
          
          .custom-scrollbar::-webkit-scrollbar {
            width: 10px;
            height: 10px;
          }
          .custom-scrollbar::-webkit-scrollbar-track {
            background: var(--muted);
          }
          .custom-scrollbar::-webkit-scrollbar-thumb {
            background: var(--border);
            border: 2px solid var(--muted);
          }
          .custom-scrollbar::-webkit-scrollbar-thumb:hover {
            background: var(--muted-foreground);
          }
        `}</style>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
