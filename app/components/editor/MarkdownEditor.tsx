'use client';

import dynamic from 'next/dynamic';
import React from 'react';
import { useTheme } from '@/app/components/ThemeProvider';
import { MermaidDiagram } from '@/components/ui/mermaid-diagram';

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
    components: {
      code: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) => {
        const lang = className?.replace('language-', '').replace('hljs', '').trim();
        const codeString = String(children).replace(/\n$/, '');
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