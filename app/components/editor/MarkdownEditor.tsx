'use client';

import dynamic from 'next/dynamic';
import React from 'react';
import { useTheme } from '@/app/components/ThemeProvider';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';
import { ColorSwatch, isColorCode } from '@/app/lib/markdown/color-swatch';
import { rehypeMermaid } from '@/app/lib/markdown/rehype-mermaid';
import { rehypeColorSwatch } from '@/app/lib/markdown/rehype-color-swatch';

const MDEditor = dynamic(
  () => import('@uiw/react-md-editor').then((mod) => mod.default),
  { ssr: false }
);

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
}

// Helper to extract text from React children
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

export function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
  const { resolvedTheme } = useTheme();
  const colorMode = resolvedTheme === 'light' ? 'light' : 'dark';

  const previewOptions = {
    rehypePlugins: [rehypeMermaid, rehypeColorSwatch] as any[],
    components: {
      div: (props: React.HTMLAttributes<HTMLDivElement> & { 'data-mermaid-code'?: string; node?: any }) => {
        const { 'data-mermaid-code': dataMermaidCode, node, ...restProps } = props;
        if (dataMermaidCode) {
          return <MermaidDiagram code={dataMermaidCode} />;
        }
        return <div {...restProps} />;
      },
      span: (props: React.HTMLAttributes<HTMLSpanElement> & { 'data-color-code'?: string; node?: any; children?: React.ReactNode }) => {
        const { 'data-color-code': dataColorCode, node, children, ...restProps } = props;
        
        // If it has explicit color-code data, render ColorSwatch
        if (dataColorCode) {
          return <ColorSwatch color={dataColorCode} />;
        }
        
        // Otherwise, check if children contains a color code (for Prism-highlighted spans)
        if (children) {
          const text = extractTextFromChildren(children);
          if (isColorCode(text)) {
            return <ColorSwatch color={text} />;
          }
        }
        
        return <span {...restProps}>{children}</span>;
      },
      code: (props: React.HTMLAttributes<HTMLElement> & { node?: any; children?: React.ReactNode }) => {
        const { node, children, ...restProps } = props;
        
        // Check if this inline code contains a color
        if (children) {
          const text = extractTextFromChildren(children);
          if (isColorCode(text)) {
            return <ColorSwatch color={text} />;
          }
        }
        
        return <code {...restProps}>{children}</code>;
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