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
};

export function InertMarkdownPreview({
  content,
  className,
  imageLabel,
  linkLabel,
}: InertMarkdownPreviewProps) {
  return (
    <div
      data-external-requests="blocked"
      className={cn('break-words', className)}
    >
      <ReactMarkdown
        skipHtml
        remarkPlugins={CANVAS_MARKDOWN_CONTENT_REMARK_PLUGINS}
        rehypePlugins={CANVAS_MARKDOWN_REHYPE_PLUGINS}
        urlTransform={() => ''}
        components={{
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
