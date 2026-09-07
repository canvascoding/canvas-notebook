'use client';

import { useId, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { MarkdownFrontmatterMode } from '@/app/lib/markdown/editor-document';
import type { MarkdownDocumentMode } from './MarkdownDocumentModes';
import { MarkdownEditor } from '@/app/components/editor/MarkdownEditorClient';

export interface MarkdownFieldProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  readOnly?: boolean;
  frontmatter?: MarkdownFrontmatterMode;
}

/** A form owns its value; the shared editor owns Markdown editing mechanics. */
export function MarkdownField({ value, onChange, label, readOnly = false, frontmatter = 'content' }: MarkdownFieldProps) {
  const t = useTranslations('notebook.editorModes');
  const labelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<MarkdownDocumentMode>(() => readOnly || value.trim() ? 'read' : 'rich');
  const fieldRef = useRef<HTMLDivElement>(null);

  const editor = (
    <MarkdownEditor
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      externalValueSync="when-blurred"
      frontmatter={frontmatter}
      layout="field"
      expanded={expanded}
      mode={mode}
      onModeChange={setMode}
      modeBarActions={!expanded && (
        <Button type="button" size="icon-sm" variant="ghost" aria-label={t('expandField')} title={t('expandField')}
          onClick={() => setExpanded(true)}>
          <Maximize2 className="size-4" aria-hidden="true" />
        </Button>
      )}
    />
  );

  return (
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <div ref={fieldRef} tabIndex={-1} className="min-w-0 rounded-md border border-input bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="group" aria-labelledby={labelId}>
        <span id={labelId} className="sr-only">{label}</span>
        {expanded ? (
          <Button type="button" variant="ghost" className="w-full" onClick={() => setExpanded(false)}>{t('collapseField')}</Button>
        ) : editor}
      </div>
      <DialogContent layout="viewport" className="gap-0" aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          fieldRef.current?.focus();
        }}>
        <div className="shrink-0 border-b px-5 py-4 pr-12">
          <DialogTitle>{label}</DialogTitle>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{expanded && editor}</div>
      </DialogContent>
    </Dialog>
  );
}
