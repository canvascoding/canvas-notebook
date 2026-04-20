'use client';

import dynamic from 'next/dynamic';
import React from 'react';
import { useTheme } from '@/app/components/ThemeProvider';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';
import { rehypeMermaid } from '@/app/lib/markdown/rehype-mermaid';

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
    rehypePlugins: [rehypeMermaid] as any[],
    components: {
      div: (props: React.HTMLAttributes<HTMLDivElement> & { dataMermaidCode?: string }) => {
        if (props.dataMermaidCode) {
          return <MermaidDiagram code={props.dataMermaidCode} />;
        }
        return <div {...props} />;
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