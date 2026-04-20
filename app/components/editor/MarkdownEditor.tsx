'use client';

import dynamic from 'next/dynamic';
import React from 'react';
import { useTheme } from '@/app/components/ThemeProvider';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';
import { ColorSwatch } from '@/app/lib/markdown/color-swatch';
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
      span: (props: React.HTMLAttributes<HTMLSpanElement> & { 'data-color-code'?: string; node?: any }) => {
        const { 'data-color-code': dataColorCode, node, ...restProps } = props;
        if (dataColorCode) {
          return <ColorSwatch color={dataColorCode} />;
        }
        return <span {...restProps} />;
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