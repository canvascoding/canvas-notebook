'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useLocale } from 'next-intl';
import { usePathname as useLocalePathname, getPathname } from '@/i18n/navigation';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';
import { ColorSwatch, isColorCode } from '@/app/lib/markdown/color-swatch';
import { rehypeInlineColorSwatch } from '@/app/lib/markdown/rehype-inline-color-swatch';
import { isFilePath, normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';
import { notifyChatFileReferenceOpened } from '@/app/lib/chat/file-reference-events';
import { extractStudioImageMediaUrls } from '@/app/lib/chat/studio-image-markdown';
import { validateFileExists } from '@/app/lib/chat/validate-file-paths';
import type { ChatMessage } from '@/app/lib/chat/types';
import { getFileDisplayPath } from '@/app/lib/files/display-name';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { toMediaUrl, toWorkspaceMediaUrl } from '@/app/lib/utils/media-url';
import { useFileStore } from '@/app/store/file-store';
import { SafeMarkdownImage } from '@/app/components/shared/SafeMarkdownImage';
import { resolvePreviewSrcFromMediaUrl } from '@/app/lib/chat/attachment-preview';
import { cn } from '@/lib/utils';

const STUDIO_MEDIA_PATH_PREFIXES = [
  'studio/',
  'studio-gen-',
  'user-uploads/studio-references/',
  'presets/',
  'products/',
  'personas/',
  'styles/',
  'references/',
];

function isExternalOrApiMediaSrc(src: string): boolean {
  return (
    src.startsWith('/') ||
    src.startsWith('#') ||
    /^[a-z][a-z0-9+.-]*:/i.test(src)
  );
}

function isStudioMediaPath(src: string): boolean {
  const normalized = src.replace(/^\/+/, '');
  return STUDIO_MEDIA_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function resolveMarkdownImageSrc(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (isStudioMediaPath(trimmed)) {
    return toMediaUrl(trimmed.replace(/^\/+/, ''));
  }

  if (isFilePath(trimmed)) {
    return toWorkspaceMediaUrl(normalizeChatFilePath(trimmed));
  }

  if (isExternalOrApiMediaSrc(trimmed)) {
    return trimmed;
  }

  return trimmed;
}

function getPlainText(children: React.ReactNode): string | null {
  const childArray = React.Children.toArray(children);
  if (childArray.length === 0) {
    return null;
  }

  let text = '';
  for (const child of childArray) {
    if (typeof child !== 'string' && typeof child !== 'number') {
      return null;
    }
    text += String(child);
  }

  return text;
}

function getFileReferenceLabel(href: string, children: React.ReactNode): React.ReactNode {
  const label = getPlainText(children)?.trim();
  if (!label) {
    return children;
  }

  if (isFilePath(label)) {
    return getFileDisplayPath(label);
  }

  const normalizedHref = normalizeChatFilePath(href);
  const normalizedLabel = normalizeChatFilePath(label);
  const labelMatchesHref =
    normalizedLabel === normalizedHref ||
    normalizedHref.endsWith(`/${normalizedLabel}`);

  return labelMatchesHref ? getFileDisplayPath(label) : children;
}

export function getRecentStudioImageMediaUrls(messages: ChatMessage[], messageIndex: number): string[] {
  const urls: string[] = [];

  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const previousMessage = messages[index];
    if (previousMessage.role === 'user') {
      break;
    }

    if (previousMessage.role === 'toolResult' && previousMessage.toolName === 'studio_generate_image') {
      urls.unshift(...extractStudioImageMediaUrls(previousMessage.content));
    }
  }

  return urls;
}

function FileLink({ href, children, showIcon = false }: { href: string; children: React.ReactNode; showIcon?: boolean }) {
  const fileStore = useFileStore();
  const fileTree = fileStore.fileTree;
  const pathname = useLocalePathname();
  const locale = useLocale();
  const [isValid, setIsValid] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    const normalizedPath = normalizeChatFilePath(href);
    validateFileExists(normalizedPath, fileTree).then((exists) => {
      setIsValid(exists);
    });
  }, [href, fileTree]);

  const handleClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const normalizedPath = normalizeChatFilePath(href);

    if (!normalizedPath) return;

    if (pathname.includes('/chat')) {
      const notebookPath = getPathname({
        locale,
        href: { pathname: '/notebook', query: { path: normalizedPath } },
      });
      window.open(notebookPath, 'canvas-notebook');
      return;
    }

    notifyChatFileReferenceOpened(normalizedPath);
    void fileStore.revealAndLoadFile(normalizedPath);
  };

  const isNotFound = isValid === false;
  const displayChildren = getFileReferenceLabel(href, children);

  if (showIcon) {
    const fileName = href.split('/').pop() || href;
    const icon = getFileIconComponent({ name: fileName, path: href, type: 'file', className: 'h-3.5 w-3.5' });

    return (
      <span className="inline-flex items-center gap-1">
        <span className="shrink-0">{icon}</span>
        <button
          onClick={handleClick}
          className={`underline underline-offset-2 transition-colors ${isNotFound ? 'text-muted-foreground cursor-not-allowed' : 'cursor-pointer text-primary hover:text-primary/80'}`}
          title={isNotFound ? `File not found: ${href}` : `Open ${href}`}
        >
          {displayChildren}
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={handleClick}
      className={`underline underline-offset-2 transition-colors ${
        isNotFound
          ? 'text-muted-foreground cursor-not-allowed'
          : 'cursor-pointer text-primary hover:text-primary/80'
      }`}
      title={isNotFound ? `File not found: ${href}` : `Open ${href}`}
    >
      {displayChildren}
    </button>
  );
}

export const MarkdownMessage = React.memo(function MarkdownMessage({
  content,
  variant,
  onMediaClick,
}: {
  content: string;
  variant: 'user' | 'assistant' | 'tool';
  onMediaClick?: (mediaUrl: string) => void;
}) {
  const sharedClasses =
    'min-w-0 max-w-full break-words text-sm leading-relaxed [&_p]:my-0 [&_p+p]:mt-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_hr]:my-4 [&_hr]:border-border/60 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-0.5 [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold';
  const toneClasses =
    variant === 'user'
      ? '[&_blockquote]:border-primary-foreground/40 [&_pre]:border-primary-foreground/20 [&_pre]:bg-primary-foreground/10 [&_code]:bg-primary-foreground/15'
      : '[&_blockquote]:border-border/80 [&_pre]:border-border [&_pre]:bg-background/80 [&_code]:bg-background/80';
  const tableBorderClasses =
    variant === 'user'
      ? 'border-primary-foreground/20'
      : 'border-border';
  const tableHeaderClasses =
    variant === 'user'
      ? 'bg-primary-foreground/10 text-primary-foreground'
      : 'bg-background/70 text-foreground';
  const tableCellClasses =
    variant === 'user'
      ? 'border-primary-foreground/20'
      : 'border-border';

  const extractColorCode = (props: Record<string, unknown>): string | null => {
    const colorCode = props['data-color-code'] ?? props.dataColorCode ?? props.datacolorcode;
    return typeof colorCode === 'string' ? colorCode : null;
  };

  const components = {
    span: ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { dataColorCode?: string }) => {
      const colorCode = extractColorCode(props as Record<string, unknown>);
      if (colorCode) {
        return <ColorSwatch color={colorCode} />;
      }
      return <span className={className} {...props} />;
    },
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      if (href && isFilePath(href)) {
        return <FileLink href={href}>{children}</FileLink>;
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
    table: ({ children }: React.TableHTMLAttributes<HTMLTableElement>) => (
      <div className={`my-3 max-w-full overflow-x-auto rounded-md border ${tableBorderClasses}`}>
        <table className="w-max min-w-full border-collapse text-left text-sm">
          {children}
        </table>
      </div>
    ),
    th: ({ children, className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
      <th
        className={cn(
          'whitespace-nowrap border px-2.5 py-1.5 align-top text-xs font-semibold',
          tableCellClasses,
          tableHeaderClasses,
          className,
        )}
        {...props}
      >
        {children}
      </th>
    ),
    td: ({ children, className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
      <td
        className={cn(
          'whitespace-nowrap border px-2.5 py-1.5 align-top',
          tableCellClasses,
          className,
        )}
        {...props}
      >
        {children}
      </td>
    ),
    img: ({ src, alt }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      if (typeof src !== 'string' || !src) return null;
      const resolvedSrc = resolveMarkdownImageSrc(src);
      const previewSrc = resolvePreviewSrcFromMediaUrl(resolvedSrc);
      const clickable = Boolean(onMediaClick);
      return (
        <SafeMarkdownImage
          src={resolvedSrc}
          previewSrc={previewSrc}
          openSrc={resolvedSrc}
          alt={alt || ''}
          wrapperClassName={`my-3 block overflow-hidden rounded-md border border-border/70 bg-background/70 ${clickable ? 'transition hover:border-primary/40' : 'cursor-default'}`}
          imageClassName="max-h-[320px] w-auto max-w-full object-contain"
          onOpen={onMediaClick}
        />
      );
    },
    code: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) => {
      const codeString = String(children).replace(/\n$/, '');
      const cleanedCode = codeString.replace(/\n$/, '').trim();
      if (isColorCode(cleanedCode)) {
        return <ColorSwatch color={cleanedCode} />;
      }

      if (!className && isFilePath(cleanedCode)) {
        return <FileLink href={cleanedCode} showIcon>{children}</FileLink>;
      }

      const lang = className?.replace('language-', '').replace('hljs', '').trim();
      if (lang === 'mermaid') {
        return <MermaidDiagram code={codeString} />;
      }

      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => {
      const child = React.Children.toArray(children)[0];
      if (React.isValidElement(child) && child.type === 'code') {
        const codeProps = child.props as { className?: string; children?: React.ReactNode };
        const lang = codeProps.className?.replace('language-', '').replace('hljs', '').trim();
        if (lang === 'mermaid') {
          return <>{children}</>;
        }
      }
      return <pre {...props}>{children}</pre>;
    },
  };

  return (
    <div className={`${sharedClasses} ${toneClasses}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeInlineColorSwatch, rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

MarkdownMessage.displayName = 'MarkdownMessage';
