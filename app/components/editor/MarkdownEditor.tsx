'use client';

import dynamic from 'next/dynamic';
import React from 'react';
import { useTheme } from '@/app/components/ThemeProvider';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';
import { SafeMarkdownImage } from '@/app/components/shared/SafeMarkdownImage';
import { ColorSwatch, isColorCode } from '@/app/lib/markdown/color-swatch';
import { resolveMarkdownImageUrl } from '@/app/lib/markdown/markdown-image-url';
import { rehypeMermaid } from '@/app/lib/markdown/rehype-mermaid';
import { rehypeInlineColorSwatch } from '@/app/lib/markdown/rehype-inline-color-swatch';

const MDEditor = dynamic(
  () => import('@uiw/react-md-editor').then((mod) => mod.default),
  { ssr: false }
);

interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  filePath?: string;
}

function extractTextFromChildren(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) {
    return children.map(extractTextFromChildren).join('');
  }
  if (React.isValidElement(children)) {
    const elementProps = children.props as { children?: React.ReactNode };
    if (elementProps.children) {
      return extractTextFromChildren(elementProps.children);
    }
  }
  return '';
}

// Check if any prop key contains a color code data attribute
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMermaidCode(props: Record<string, any>): string | null {
  // Try all possible naming conventions for the data attribute
  if (props['data-mermaid-code']) return String(props['data-mermaid-code']);
  if (props['dataMermaidCode']) return String(props['dataMermaidCode']);
  if (props['datamermaidcode']) return String(props['datamermaidcode']);
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractColorCode(props: Record<string, any>): string | null {
  if (props['data-color-code']) return String(props['data-color-code']);
  if (props['dataColorCode']) return String(props['dataColorCode']);
  if (props['datacolorcode']) return String(props['datacolorcode']);
  return null;
}

function MarkdownPreviewImage({
  src,
  alt,
  filePath,
}: React.ImgHTMLAttributes<HTMLImageElement> & { filePath?: string }) {
  if (typeof src !== 'string' || !src) return null;

  const resolvedImage = resolveMarkdownImageUrl(src, filePath);
  if (!resolvedImage.ok) {
    return (
      <span
        role="img"
        aria-label={resolvedImage.error}
        title={src}
        className="my-2 inline-flex max-w-full items-center rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
      >
        {resolvedImage.error}
      </span>
    );
  }

  return (
    <SafeMarkdownImage
      src={src}
      previewSrc={resolvedImage.src}
      alt={alt || ''}
      imageClassName="my-2 max-h-[60vh] w-auto max-w-full rounded-md object-contain"
      showError
      errorLabel={`Image could not be loaded: ${src}`}
      errorClassName="my-2"
    />
  );
}

export function MarkdownEditor({ value, onChange, readOnly = false, filePath }: MarkdownEditorProps) {
  const { resolvedTheme } = useTheme();
  const colorMode = resolvedTheme === 'light' ? 'light' : 'dark';

  const previewOptions = React.useMemo(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rehypePlugins: [rehypeInlineColorSwatch, rehypeMermaid] as any[],
    components: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      span: (props: any) => {
        const colorCode = extractColorCode(props);
        if (colorCode) {
          return <ColorSwatch color={colorCode} />;
        }
        return <span {...props} />;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      div: (props: any) => {
        const mermaidCode = extractMermaidCode(props);
        const { ...restProps } = props;
        if (mermaidCode) {
          return <MermaidDiagram code={mermaidCode} />;
        }
        return <div {...restProps} />;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      code: (props: any) => {
        const { className, children, ...restProps } = props;
        const text = extractTextFromChildren(children);
        
        // Check if this inline code contains a color
        const classNames = Array.isArray(className) ? className : (className ? [className] : []);
        const hasLanguage = classNames.some((c: string) => typeof c === 'string' && c.startsWith('language-'));
        
        if (!hasLanguage && isColorCode(text)) {
          return <ColorSwatch color={text} />;
        }
        
        return <code className={className} {...restProps}>{children}</code>;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      img: (props: any) => (
        <MarkdownPreviewImage
          src={props.src}
          alt={props.alt}
          filePath={filePath}
        />
      ),
    },
  }), [filePath]);

  return (
    <div className="h-full overflow-hidden" data-color-mode={colorMode}>
      <MDEditor
        value={value}
        onChange={(nextValue) => {
          if (!readOnly) onChange?.(nextValue ?? '');
        }}
        preview="preview"
        hideToolbar={readOnly}
        textareaProps={{ readOnly }}
        visibleDragbar={false}
        height="100%"
        style={{ height: '100%' }}
        previewOptions={previewOptions}
      />
    </div>
  );
}
