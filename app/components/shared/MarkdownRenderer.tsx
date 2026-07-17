'use client';

import React, { useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { isColorCode, ColorSwatch } from '@/app/lib/markdown/color-swatch';
import {
  CANVAS_MARKDOWN_REHYPE_PLUGINS,
  CANVAS_MARKDOWN_REMARK_PLUGINS,
} from '@/app/lib/markdown/canvas-markdown';
import { SafeMarkdownImage } from '@/app/components/shared/SafeMarkdownImage';
import { ObsidianWikiLink } from '@/app/components/shared/ObsidianWikiLink';
import { WorkspaceMarkdownEmbed } from '@/app/components/shared/WorkspaceMarkdownEmbed';
import {
  ObsidianCallout,
  ObsidianInlineFootnote,
} from '@/app/components/shared/ObsidianMarkdownElements';
import { getWorkspaceMarkdownNavigationTarget } from '@/app/lib/markdown/obsidian-link-resolver';
import {
  markdownHeadingAnchorFromHref,
  scrollToMarkdownHeadingAnchor,
} from '@/app/lib/markdown/heading-anchor';
import { cn } from '@/lib/utils';

interface MarkdownRendererProps {
  content: string;
  variant?: 'default' | 'muted';
  className?: string;
  embedAncestorPaths?: string[];
  sourcePath?: string;
}

const SHARED_CLASSES =
  'break-words [&_p]:my-0 [&_p+p]:mt-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_hr]:my-4 [&_hr]:border-border/60 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-0.5 [&_a]:underline [&_a]:underline-offset-2 [&_h1[id]]:scroll-mt-4 [&_h2[id]]:scroll-mt-4 [&_h3[id]]:scroll-mt-4 [&_h4[id]]:scroll-mt-4 [&_h5[id]]:scroll-mt-4 [&_h6[id]]:scroll-mt-4 [&_strong]:font-semibold [&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden';

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
  embedAncestorPaths,
  sourcePath,
}: MarkdownRendererProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ancestorPaths = embedAncestorPaths ?? (sourcePath ? [sourcePath] : []);
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
      ...props
    }: {
      href?: string;
      children?: React.ReactNode;
      'data-canvas-wiki-embed'?: string;
      'data-canvas-wiki-target'?: string;
      'data-canvas-wiki-transclude'?: string;
    }) => {
      const wikiTarget = props['data-canvas-wiki-target'];
      if (wikiTarget) {
        if (
          props['data-canvas-wiki-embed'] === 'true'
          && props['data-canvas-wiki-transclude'] === 'true'
        ) {
          return (
            <WorkspaceMarkdownEmbed
              target={wikiTarget}
              sourcePath={sourcePath}
              ancestorPaths={ancestorPaths}
              renderContent={(nestedContent, nestedSourcePath, nestedAncestors) => (
                <MarkdownRenderer
                  content={nestedContent}
                  sourcePath={nestedSourcePath}
                  embedAncestorPaths={nestedAncestors}
                  className="text-sm"
                />
              )}
            />
          );
        }
        return (
          <ObsidianWikiLink
            target={wikiTarget}
            sourcePath={sourcePath}
            embed={props['data-canvas-wiki-embed'] === 'true'}
            preferDocumentTitle
          >
            {children}
          </ObsidianWikiLink>
        );
      }
      if (href && markdownHeadingAnchorFromHref(href)) {
        return (
          <a
            href={href}
            className="underline underline-offset-2"
            onClick={(event) => {
              event.preventDefault();
              if (rootRef.current) scrollToMarkdownHeadingAnchor(rootRef.current, href);
            }}
          >
            {children}
          </a>
        );
      }
      const workspaceTarget = href ? getWorkspaceMarkdownNavigationTarget(href, sourcePath) : null;
      if (workspaceTarget) {
        return (
          <ObsidianWikiLink target={workspaceTarget} sourcePath={sourcePath}>
            {children}
          </ObsidianWikiLink>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          {children}
        </a>
      );
    },
    img: ({
      src,
      alt,
    }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      if (typeof src !== 'string' || !src) return null;
      return (
        <SafeMarkdownImage
          src={src}
          alt={alt || ''}
          imageClassName="my-2 max-h-[320px] w-auto max-w-full rounded-lg object-contain"
        />
      );
    },
    blockquote: ({
      children,
      className: blockquoteClassName,
      node: _node,
      ...props
    }: React.BlockquoteHTMLAttributes<HTMLQuoteElement> & {
      'data-callout'?: string;
      'data-callout-fold'?: string;
      'data-callout-title'?: string;
      node?: unknown;
    }) => {
      const calloutType = props['data-callout'];
      if (typeof calloutType === 'string') {
        return (
          <ObsidianCallout
            type={calloutType}
            title={typeof props['data-callout-title'] === 'string' ? props['data-callout-title'] : undefined}
            fold={typeof props['data-callout-fold'] === 'string' ? props['data-callout-fold'] : undefined}
            className={blockquoteClassName}
          >
            {children}
          </ObsidianCallout>
        );
      }
      return <blockquote className={blockquoteClassName}>{children}</blockquote>;
    },
    sup: ({
      children,
      node: _node,
      ...props
    }: React.HTMLAttributes<HTMLElement> & {
      'data-inline-footnote'?: string;
      'data-inline-footnote-index'?: string;
      node?: unknown;
    }) => {
      const content = props['data-inline-footnote'];
      const index = props['data-inline-footnote-index'];
      if (typeof content === 'string') {
        return <ObsidianInlineFootnote content={content} index={typeof index === 'string' ? index : 1} />;
      }
      return <sup>{children}</sup>;
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
      ref={rootRef}
      className={cn(
        SHARED_CLASSES,
        VARIANT_CLASSES[variant],
        DEFAULT_TEXT_CLASSES[variant],
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={CANVAS_MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={CANVAS_MARKDOWN_REHYPE_PLUGINS}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
