'use client';

import React from 'react';
import { Check, Copy, Folder } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useTranslations } from 'next-intl';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';
import { ColorSwatch, isColorCode } from '@/app/lib/markdown/color-swatch';
import {
  CANVAS_MARKDOWN_REHYPE_PLUGINS,
  CANVAS_MARKDOWN_REMARK_PLUGINS,
} from '@/app/lib/markdown/canvas-markdown';
import { isFilePath, normalizeChatFilePath } from '@/app/lib/chat/extract-file-paths';
import { extractStudioImageMediaUrls } from '@/app/lib/chat/studio-image-markdown';
import {
  subscribeToFileReferenceValidationInvalidation,
  validateFileReference,
  type FileReferenceValidationResult,
} from '@/app/lib/chat/validate-file-paths';
import type { ChatMessage } from '@/app/lib/chat/types';
import { getFileDisplayPath } from '@/app/lib/files/display-name';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { toMediaUrl, toWorkspaceMediaUrl } from '@/app/lib/utils/media-url';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { SafeMarkdownImage } from '@/app/components/shared/SafeMarkdownImage';
import { resolvePreviewSrcFromMediaUrl } from '@/app/lib/chat/attachment-preview';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useOpenChatFileReference } from '@/app/components/canvas-agent-chat/useOpenChatFileReference';
import { LEGACY_PERSONAL_WORKSPACE_ID } from '@/app/lib/workspaces/constants';

const CodeBlockContext = React.createContext(false);

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

function resolveMarkdownImageSrc(src: string, workspaceId: string | null): string {
  const trimmed = src.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (isStudioMediaPath(trimmed)) {
    return toMediaUrl(trimmed.replace(/^\/+/, ''));
  }

  if (isFilePath(trimmed)) {
    return toWorkspaceMediaUrl(normalizeChatFilePath(trimmed), { workspaceId });
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

function getReactNodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getReactNodeText).join('');
  }

  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return getReactNodeText(node.props.children);
  }

  return '';
}

function getCodeLanguage(className?: string): string | null {
  if (!className) {
    return null;
  }

  const languageClass = className
    .split(/\s+/)
    .find((item) => item.startsWith('language-'));

  if (languageClass) {
    return languageClass.replace(/^language-/, '').trim() || null;
  }

  const fallbackLanguage = className.replace(/\bhljs\b/g, '').trim();
  return fallbackLanguage || null;
}

type MarkdownCodeElementProps = {
  className?: string;
  children?: React.ReactNode;
};

function isMarkdownCodeElement(node: React.ReactNode): node is React.ReactElement<MarkdownCodeElementProps> {
  return React.isValidElement<MarkdownCodeElementProps>(node);
}

async function writeTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  const selection = document.getSelection();
  const selectedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand('copy')) {
      throw new Error('Clipboard copy failed.');
    }
  } finally {
    document.body.removeChild(textarea);
    if (selection && selectedRange) {
      selection.removeAllRanges();
      selection.addRange(selectedRange);
    }
  }
}

function getCodeBlockDetails(children: React.ReactNode): { code: string; language: string | null } {
  const child = React.Children.toArray(children)[0];
  if (!isMarkdownCodeElement(child)) {
    return { code: getReactNodeText(children).replace(/\n$/, ''), language: null };
  }

  return {
    code: getReactNodeText(child.props.children).replace(/\n$/, ''),
    language: getCodeLanguage(child.props.className),
  };
}

function MarkdownCodeBlock({
  children,
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLPreElement> & {
  children?: React.ReactNode;
  variant: 'user' | 'assistant' | 'tool';
}) {
  const t = useTranslations('chat');
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimerRef = React.useRef<number | null>(null);
  const { code, language } = React.useMemo(() => getCodeBlockDetails(children), [children]);
  const canCopy = code.length > 0;

  React.useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const scheduleReset = React.useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1400);
  }, []);

  const handleCopy = React.useCallback(async () => {
    if (!canCopy) {
      return;
    }

    try {
      await writeTextToClipboard(code);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    scheduleReset();
  }, [canCopy, code, scheduleReset]);

  const copyLabel = copyState === 'copied' ? t('copied') : t('copy');
  const CopyIcon = copyState === 'copied' ? Check : Copy;

  return (
    <div
      className={cn(
        'markdown-code-block group my-3 max-w-full overflow-hidden border shadow-sm',
        variant === 'user'
          ? 'border-primary-foreground/25 bg-background text-foreground'
          : 'border-border bg-background/95 text-foreground',
      )}
    >
      <div
        className={cn(
          'flex min-h-8 items-center justify-between gap-2 border-b px-2 py-1',
          variant === 'user' ? 'border-border/80 bg-muted/50' : 'border-border/70 bg-muted/35',
        )}
      >
        <span
          className={cn(
            'min-w-0 truncate text-[10px] font-semibold uppercase leading-4 tracking-wider text-muted-foreground',
            !language && 'sr-only',
          )}
        >
          {language || 'code'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            'h-7 w-7 border border-border/80 bg-background/95 text-muted-foreground shadow-sm transition hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100',
            copyState !== 'idle' && 'sm:opacity-100',
          )}
          onClick={() => void handleCopy()}
          disabled={!canCopy}
          aria-label={copyLabel}
          title={copyLabel}
        >
          <CopyIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
      <pre
        className={cn(
          '!m-0 max-w-full overflow-x-auto !rounded-none !border-0 !bg-transparent !p-3 text-left text-[0.8125rem] leading-6',
          className,
        )}
        {...props}
      >
        <CodeBlockContext.Provider value>
          {children}
        </CodeBlockContext.Provider>
      </pre>
    </div>
  );
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
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const openFileReference = useOpenChatFileReference();
  const normalizedPath = React.useMemo(() => normalizeChatFilePath(href), [href]);
  const [validationState, setValidationState] = React.useState<{
    workspaceId: string | null;
    result: FileReferenceValidationResult;
  } | null>(null);
  const [validationVersion, setValidationVersion] = React.useState(0);

  React.useEffect(() => subscribeToFileReferenceValidationInvalidation((event) => {
    if (event.workspaceId !== (activeWorkspaceId ?? LEGACY_PERSONAL_WORKSPACE_ID)) return;
    if (
      event.path &&
      event.path !== normalizedPath &&
      !event.path.startsWith(`${normalizedPath}/`) &&
      !normalizedPath.startsWith(`${event.path}/`)
    ) return;
    setValidationVersion((version) => version + 1);
  }), [activeWorkspaceId, normalizedPath]);

  React.useEffect(() => {
    if (!normalizedPath) {
      return;
    }

    let cancelled = false;
    const { fileTree, fileTreeWorkspaceId } = useFileStore.getState();

    validateFileReference(normalizedPath, fileTree, { fileTreeWorkspaceId }).then((result) => {
      if (!cancelled) {
        setValidationState({ workspaceId: activeWorkspaceId, result });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, normalizedPath, validationVersion]);

  const handleClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const validation = validationState?.workspaceId === activeWorkspaceId
      ? validationState.result
      : null;
    if (!normalizedPath || validation?.path !== normalizedPath || validation.type !== 'file') return;

    void openFileReference(normalizedPath);
  };

  const displayChildren = getFileReferenceLabel(href, children);
  const activeValidation = validationState?.workspaceId === activeWorkspaceId && validationState.result.path === normalizedPath
    ? validationState.result
    : null;
  const isFile = activeValidation?.type === 'file';
  const isDirectory = activeValidation?.type === 'directory';
  const isMissing = !normalizedPath || activeValidation?.type === 'missing';

  if (!isFile) {
    if (isDirectory) {
      return (
        <span
          className="inline text-muted-foreground"
          title={`Folder: ${normalizedPath || href}`}
        >
          <Folder className="mr-1 inline-block h-3.5 w-3.5 align-[-2px]" />
          <span>{displayChildren}</span>
        </span>
      );
    }

    return (
      <span
        className="inline text-inherit"
        title={isMissing ? `File not found: ${normalizedPath || href}` : undefined}
      >
        {displayChildren}
      </span>
    );
  }

  if (showIcon) {
    const fileName = href.split('/').pop() || href;
    const icon = getFileIconComponent({ name: fileName, path: href, type: 'file', className: 'h-3.5 w-3.5' });

    return (
      <span className="inline-flex items-center gap-1">
        <span className="shrink-0">{icon}</span>
        <button
          type="button"
          onClick={handleClick}
          className="inline cursor-pointer p-0 text-left align-baseline text-primary underline underline-offset-2 transition-colors hover:text-primary/80"
          title={`Open ${normalizedPath || href}`}
        >
          {displayChildren}
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline cursor-pointer p-0 text-left align-baseline text-primary underline underline-offset-2 transition-colors hover:text-primary/80"
      title={`Open ${normalizedPath || href}`}
    >
      {displayChildren}
    </button>
  );
}

function MarkdownCode({
  className,
  children,
  node: _node,
  ...props
}: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode; node?: unknown }) {
  const isRenderingCodeBlock = React.useContext(CodeBlockContext);
  const codeString = getReactNodeText(children).replace(/\n$/, '');
  const cleanedCode = codeString.replace(/\n$/, '').trim();

  if (isRenderingCodeBlock) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  if (isColorCode(cleanedCode)) {
    return <ColorSwatch color={cleanedCode} />;
  }

  if (!className && isFilePath(cleanedCode)) {
    return <FileLink href={cleanedCode} showIcon>{children}</FileLink>;
  }

  const lang = getCodeLanguage(className);
  if (lang === 'mermaid') {
    return <MermaidDiagram code={codeString} />;
  }

  return (
    <code className={className} {...props}>
      {children}
    </code>
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
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const sharedClasses =
    'min-w-0 max-w-full break-words text-sm leading-relaxed [&_p]:my-0 [&_p+p]:mt-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_hr]:my-4 [&_hr]:border-border/60 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-0.5 [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold [&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden';
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
      const resolvedSrc = resolveMarkdownImageSrc(src, activeWorkspaceId);
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
    code: MarkdownCode,
    pre: ({
      children,
      node: _node,
      ...props
    }: React.HTMLAttributes<HTMLPreElement> & { children?: React.ReactNode; node?: unknown }) => {
      const child = React.Children.toArray(children)[0];
      if (isMarkdownCodeElement(child)) {
        const lang = getCodeLanguage(child.props.className);
        if (lang === 'mermaid') {
          return <>{children}</>;
        }
      }
      return (
        <MarkdownCodeBlock variant={variant} {...props}>
          {children}
        </MarkdownCodeBlock>
      );
    },
  };

  return (
    <div className={`${sharedClasses} ${toneClasses}`}>
      <ReactMarkdown
        remarkPlugins={CANVAS_MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={CANVAS_MARKDOWN_REHYPE_PLUGINS}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

MarkdownMessage.displayName = 'MarkdownMessage';
