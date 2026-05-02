'use client';

import dynamic from 'next/dynamic';
import React from 'react';
import { useTheme } from '@/app/components/ThemeProvider';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';
import { ColorSwatch, isColorCode } from '@/app/lib/markdown/color-swatch';
import { rehypeMermaid } from '@/app/lib/markdown/rehype-mermaid';
import { rehypeInlineColorSwatch } from '@/app/lib/markdown/rehype-inline-color-swatch';

const MDEditor = dynamic(
  () => import('@uiw/react-md-editor').then((mod) => mod.default),
  { ssr: false }
);

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
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

export function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
  const { resolvedTheme } = useTheme();
  const colorMode = resolvedTheme === 'light' ? 'light' : 'dark';

  const previewOptions = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rehypePlugins: [rehypeInlineColorSwatch, rehypeMermaid] as any[],
    components: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      span: (props: any) => {
        const classNames = Array.isArray(props.className) ? props.className : (props.className ? [props.className] : []);
        if (classNames.includes('color-swatch-container') && props.dataColorCode) {
          return <ColorSwatch color={props.dataColorCode} />;
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
    },
  };

  return (
    <div className="h-full overflow-hidden" data-color-mode={colorMode}>
      <MDEditor
        value={value}
        onChange={(nextValue) => onChange(nextValue ?? '')}
        preview="preview"
        visibleDragbar={false}
        height="100%"
        style={{ height: '100%' }}
        previewOptions={previewOptions}
      />
    </div>
  );
}