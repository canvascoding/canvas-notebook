'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { isColorCode, ColorSwatch } from '@/app/lib/markdown/color-swatch';
import { rehypeInlineColorSwatch } from '@/app/lib/markdown/rehype-inline-color-swatch';
import { cn } from '@/lib/utils';

interface MarkdownRendererProps {
  content: string;
  variant?: 'default' | 'muted';
  className?: string;
}

const SHARED_CLASSES =
  'break-words [&_p]:my-0 [&_p+p]:mt-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_hr]:my-4 [&_hr]:border-border/60 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-0.5 [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold';

const VARIANT_CLASSES: Record<string, string> = {
  default:
    '[&_blockquote]:border-border/80 [&_pre]:border-border [&_pre]:bg-background/80 [&_code]:bg-background/80 [&_th]:border-border [&_td]:border-border',
  muted:
    '[&_blockquote]:border-border/60 [&_pre]:border-border/50 [&_pre]:bg-muted/30 [&_code]:bg-muted/40 [&_th]:border-border/50 [&_td]:border-border/50',
};

const DEFAULT_TEXT_CLASSES: Record<string, string> = {
  default: 'text-sm leading-relaxed',
  muted: 'text-xs leading-5',
};

export function MarkdownRenderer({
  content,
  variant = 'default',
  className,
}: MarkdownRendererProps) {
  const extractColorCode = (props: Record<string, unknown>): string | null => {
    const colorCode =
      props['data-color-code'] ?? props.dataColorCode ?? props.datacolorcode;
    return typeof colorCode === 'string' ? colorCode : null;
  };

  const components = {
    span: ({
      className: spanClassName,
      ...props
    }: React.HTMLAttributes<HTMLSpanElement> & { dataColorCode?: string }) => {
      const colorCode = extractColorCode(props as Record<string, unknown>);
      if (colorCode) {
        return <ColorSwatch color={colorCode} />;
      }
      return <span className={spanClassName} {...props} />;
    },
    a: ({
      href,
      children,
    }: {
      href?: string;
      children?: React.ReactNode;
    }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2"
      >
        {children}
      </a>
    ),
    img: ({
      src,
      alt,
    }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      if (typeof src !== 'string' || !src) return null;
      return (
        // Markdown image sources can be arbitrary user-provided URLs, so next/image
        // domain restrictions are not a good fit for this renderer.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt || ''}
          className="my-2 max-h-[320px] w-auto max-w-full rounded-lg object-contain"
        />
      );
    },
    code: ({
      className: codeClassName,
      children,
      ...props
    }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) => {
      const codeString = String(children).replace(/\n$/, '');
      const cleanedCode = codeString.trim();
      if (isColorCode(cleanedCode)) {
        return <ColorSwatch color={cleanedCode} />;
      }
      return (
        <code className={codeClassName} {...props}>
          {children}
        </code>
      );
    },
  };

  return (
    <div
      className={cn(
        SHARED_CLASSES,
        VARIANT_CLASSES[variant],
        DEFAULT_TEXT_CLASSES[variant],
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeInlineColorSwatch, rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
