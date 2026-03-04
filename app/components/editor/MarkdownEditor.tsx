'use client';

import dynamic from 'next/dynamic';
import { useTheme } from 'next-themes';

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

  return (
    <div className="h-full overflow-hidden" data-color-mode={colorMode}>
      <MDEditor
        value={value}
        onChange={(nextValue) => onChange(nextValue ?? '')}
        preview="live"
        visibleDragbar={false}
        height="100%"
        style={{ height: '100%' }}
      />
    </div>
  );
}
