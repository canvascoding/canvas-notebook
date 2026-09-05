'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';

const MEMORY_MARKDOWN_ELEMENTS = [
  'p',
  'strong',
  'em',
  'del',
  'code',
  'ul',
  'ol',
  'li',
  'blockquote',
  'a',
  'br',
] as const;

type MemoryMarkdownContentProps = {
  content: string;
  className?: string;
};

export function MemoryMarkdownContent({ content, className }: MemoryMarkdownContentProps) {
  return (
    <div
      className={cn(
        'min-w-0 break-words text-sm leading-6 text-foreground',
        '[&_p]:my-0 [&_p+p]:mt-2',
        '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5',
        '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5',
        '[&_li]:pl-0.5 [&_li>p]:inline',
        '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30',
        '[&_blockquote]:bg-muted/35 [&_blockquote]:px-3 [&_blockquote]:py-1.5 [&_blockquote]:text-muted-foreground',
        '[&_code]:break-all [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
        '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:decoration-primary/35 [&_a]:underline-offset-2',
        '[&_a:hover]:decoration-primary',
        className,
      )}
      data-testid="memory-markdown-content"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={[...MEMORY_MARKDOWN_ELEMENTS]}
        unwrapDisallowed
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
