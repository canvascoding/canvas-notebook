'use client';

import { useRef, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useTranslations } from 'next-intl';
import { AlignLeft, AlignCenter, AlignRight, RotateCcw } from 'lucide-react';
import { SafeMarkdownImage } from '@/app/components/shared/SafeMarkdownImage';
import { imageAlignment, imageDimension, MAX_IMAGE_DIMENSION, portableImageStyle } from '@/app/lib/markdown/core/portable-image';
import { cn } from '@/lib/utils';

export function MarkdownImageControls({ node, editor, selected, getPos, updateAttributes, previewSrc, error }: NodeViewProps & {
  previewSrc?: string; error?: string;
}) {
  const t = useTranslations('notebook.editorImage');
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; max: number; node: typeof node } | null>(null);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const width = imageDimension(node.attrs.width);
  const align = imageAlignment(node.attrs.align);
  const src = String(node.attrs.src ?? '');
  const alt = String(node.attrs.alt ?? '');
  const editable = editor.isEditable && selected;
  const cancel = () => { drag.current = null; setPreviewWidth(null); };
  const commit = (next: number) => {
    if (!editor.isEditable) return;
    updateAttributes({ width: Math.round(Math.min(MAX_IMAGE_DIMENSION, Math.max(48, next))), height: null });
  };
  return <NodeViewWrapper as="figure" contentEditable={false} data-testid="markdown-image-node"
    className={cn('relative my-4 max-w-full rounded-md border border-transparent p-1', selected && 'border-primary/60 bg-primary/5')}>
    <div ref={frame} className="relative" style={portableImageStyle({ width: previewWidth ?? width, height: null, align })}>
      {previewSrc ? <SafeMarkdownImage src={src} previewSrc={previewSrc} alt={alt}
        imageClassName={cn('block h-auto max-w-full rounded-md object-contain', width || previewWidth ? 'w-full' : 'w-auto')}
        showError errorLabel={t('unavailable')} /> : <span role="img" aria-label={error}>{error}</span>}
      {editable && previewSrc ? <button type="button" aria-label={t('resize')} data-testid="image-resize-handle"
        className="absolute -bottom-2 -right-2 size-6 touch-none cursor-nwse-resize rounded-full border-2 border-background bg-primary shadow focus-visible:ring-2 focus-visible:ring-ring"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          const rect = frame.current?.getBoundingClientRect();
          if (!rect) return;
          drag.current = { x: event.clientX, width: rect.width, max: Math.min(MAX_IMAGE_DIMENSION, frame.current?.parentElement?.clientWidth ?? MAX_IMAGE_DIMENSION), node };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start) setPreviewWidth(Math.round(Math.max(48, Math.min(start.max, start.width + event.clientX - start.x))));
        }}
        onPointerUp={(event) => {
          const start = drag.current;
          const position = getPos();
          // A concurrent replacement/deletion must never receive a stale resize.
          if (start && typeof position === 'number' && editor.state.doc.nodeAt(position)?.eq(start.node)) {
            commit(Math.min(start.max, start.width + event.clientX - start.x));
          }
          cancel();
        }}
        onPointerCancel={cancel} onLostPointerCapture={cancel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); cancel(); }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            commit((width ?? frame.current?.clientWidth ?? 320) + (event.key === 'ArrowRight' ? 16 : -16));
          }
        }} /> : null}
    </div>
    {alt ? <figcaption className="mt-2 text-center text-xs text-muted-foreground">{alt}</figcaption> : null}
    {editable ? <div role="toolbar" aria-label={t('tools')} className="mt-2 flex flex-wrap items-center justify-center gap-1 rounded-md bg-popover p-1 text-popover-foreground"
      onPointerDown={(event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}>
      {([{ value: 'left', Icon: AlignLeft }, { value: 'center', Icon: AlignCenter }, { value: 'right', Icon: AlignRight }] as const).map(({ value, Icon }) =>
        <button key={value} type="button" aria-label={t(value)} title={t(value)} aria-pressed={align === value}
          className="size-9 rounded hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => updateAttributes({ align: value })}><Icon className="mx-auto size-4" /></button>)}
      <label className="flex items-center gap-2 px-2 text-xs">{t('width')}
        <input key={width ?? 'auto'} type="number" min={48} max={MAX_IMAGE_DIMENSION} step={16} defaultValue={width ?? ''}
          placeholder={t('auto')} className="h-8 w-20 rounded border bg-background px-2" aria-label={t('width')}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}
          onBlur={(event) => { const next = imageDimension(event.currentTarget.value); if (next !== null && next !== width) commit(next); }} />px
      </label>
      <button type="button" aria-label={t('reset')} title={t('reset')} className="size-9 rounded hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => updateAttributes({ width: null, height: null, align: null })}><RotateCcw className="mx-auto size-4" /></button>
    </div> : null}
  </NodeViewWrapper>;
}
