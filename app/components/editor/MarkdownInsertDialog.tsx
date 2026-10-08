'use client';

import { useId, useMemo, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { EditorRangeTarget } from '@/app/lib/editor/interaction-target';
import { insertPreparedMarkdown, prepareMarkdownInsertion } from '@/app/lib/editor/markdown-insertion';
import type { MarkdownFrontmatterMode } from '@/app/lib/markdown/editor-document';

/** Mounted for one action; a failed insertion always keeps the user's draft. */
export function MarkdownInsertDialog({ editor, target, frontmatter, readOnly, onClose }: {
  editor: Editor | null;
  target: EditorRangeTarget | null;
  frontmatter: MarkdownFrontmatterMode;
  readOnly: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('notebook.markdownInsert');
  const id = useId();
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState<'target_changed' | 'invalid_content' | null>(null);
  const prepared = useMemo(() => prepareMarkdownInsertion(markdown, frontmatter), [markdown, frontmatter]);
  const blocked = readOnly || !editor || editor.isDestroyed || !editor.isEditable;
  const reason = blocked ? 'read_only' : error ?? (!prepared.ok && prepared.reason !== 'empty' ? prepared.reason : null);

  const insert = () => {
    if (blocked || !editor || !prepared.ok) return;
    const result = insertPreparedMarkdown(editor, target, prepared);
    if (!result.ok) { setError(result.reason); return; }
    onClose();
  };

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (editor && target?.editor === editor && !editor.isDestroyed) editor.view.focus();
      }}>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <div className="grid min-w-0 gap-2">
        <Label htmlFor={id}>{t('label')}</Label>
        <Textarea id={id} autoFocus spellCheck={false} value={markdown}
          className="h-[min(36dvh,18rem)] min-h-24 resize-y font-mono [field-sizing:fixed]"
          aria-invalid={Boolean(reason)} aria-describedby={reason ? `${id}-error` : undefined}
          onChange={(event) => { setMarkdown(event.target.value); setError(null); }} />
        {reason ? <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{t(`errors.${reason}`)}</p> : null}
        {prepared.ok && prepared.normalizations.length > 0 ? <p className="text-sm text-muted-foreground">{t('normalization')}</p> : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button>
        <Button type="button" disabled={blocked || !prepared.ok} onClick={insert}>{t('insert')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
