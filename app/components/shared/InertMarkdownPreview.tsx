'use client';

import type { ReactNode } from 'react';
import { ImageOff, Link2Off } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

import {
  CANVAS_MARKDOWN_CONTENT_REMARK_PLUGINS,
  CANVAS_MARKDOWN_REHYPE_PLUGINS,
} from '@/app/lib/markdown/canvas-markdown';
import { cn } from '@/lib/utils';

type InertMarkdownPreviewProps = {
  content: string;
  className?: string;
  imageLabel: string;
  linkLabel: string;
  tableLabel: string;
};

export function InertMarkdownPreview({
  content,
  className,
  imageLabel,
  linkLabel,
  tableLabel,
}: InertMarkdownPreviewProps) {
  return (
    <div
      data-external-requests="blocked"
      className={cn('min-w-0 break-words [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto', className)}
    >
      <ReactMarkdown
        skipHtml
        remarkPlugins={CANVAS_MARKDOWN_CONTENT_REMARK_PLUGINS}
        rehypePlugins={CANVAS_MARKDOWN_REHYPE_PLUGINS}
        urlTransform={() => ''}
        components={{
          table: ({ children }) => (
            <div role="region" aria-label={tableLabel} tabIndex={0}
              className="my-3 max-w-full overflow-x-auto overscroll-x-contain rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
              <table className="border-collapse whitespace-normal text-left"
                style={{ width: 'max-content', minWidth: '100%' }}>{children}</table>
            </div>
          ),
          th: ({ children, align, style }) => (
            <th className="border border-border bg-muted/60 px-2 py-1.5 align-top font-semibold"
              style={{ minWidth: '9rem', textAlign: style?.textAlign ?? (align === 'center' || align === 'right' ? align : 'left') }}>{children}</th>
          ),
          td: ({ children, align, style }) => (
            <td className="border border-border px-2 py-1.5 align-top"
              style={{ minWidth: '9rem', textAlign: style?.textAlign ?? (align === 'center' || align === 'right' ? align : 'left') }}>{children}</td>
          ),
          a: ({ children }: { children?: ReactNode }) => (
            <span className="inline-flex items-baseline gap-1 underline decoration-dotted underline-offset-2">
              {children}
              <Link2Off className="inline size-3 shrink-0 text-muted-foreground" aria-label={linkLabel} />
            </span>
          ),
          img: ({ alt }: { alt?: string }) => (
            <span role="note" className="my-2 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              <ImageOff className="size-3.5 shrink-0" aria-hidden="true" />
              {imageLabel}{alt ? `: ${alt}` : ''}
            </span>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
