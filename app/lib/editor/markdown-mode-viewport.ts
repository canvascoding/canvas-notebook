'use client';

import { useLayoutEffect, useRef } from 'react';
import type { Editor, JSONContent } from '@tiptap/core';
import { EditorView } from '@codemirror/view';
import type { MarkdownFrontmatterMode } from '../markdown/editor-document';
import { createMarkdownViewPositionMap, type MarkdownViewBlock } from './markdown-view-position-map';

export type MarkdownViewportMode = 'read' | 'rich' | 'source';
export type MarkdownViewportAnchor = {
  sourceOffset: number;
  viewportOffset: number;
  blockId?: string;
  blockOffset?: number;
  atStart?: boolean;
};
export type MarkdownViewportAdapter = {
  key: object;
  mode: MarkdownViewportMode;
  element: HTMLElement;
  content: HTMLElement;
  version?: () => unknown;
  capture: () => MarkdownViewportAnchor | null;
  restore: (anchor: MarkdownViewportAnchor, done: (updated?: MarkdownViewportAnchor) => void, current: () => boolean) => void | (() => void);
};

const pendingSourceScrolls = new WeakMap<EditorView, { offset: number; margin: number; coarseConsumed: boolean; current: () => boolean }>();
/** Cancel only our queued handoff, without overriding user scrolling/navigation. */
export const markdownViewportSourceExtensions = [
  EditorView.updateListener.of(update => {
    const pending = pendingSourceScrolls.get(update.view);
    if (pending && update.docChanged) pending.offset = update.changes.mapPos(pending.offset);
  }),
  EditorView.scrollHandler.of((view, range, options) => {
    const pending = pendingSourceScrolls.get(view);
    if (!pending || pending.coarseConsumed) return false;
    pending.coarseConsumed = true;
    if (!pending.current()) pendingSourceScrolls.delete(view);
    return range.head === pending.offset && options.y === 'start' && options.yMargin === pending.margin && !pending.current();
  }),
];

/** View state belongs to the open document, never to its Markdown or undo history. */
export class MarkdownModeViewport {
  private active: MarkdownViewportAdapter | null = null;
  private pending: MarkdownViewportAnchor | null = null;
  private handoff: { key: object; anchor: MarkdownViewportAnchor; scrollTop: number; width: number; version: unknown } | null = null;
  private stopRestoring: (() => void) | null = null;
  private navigationRequest: string | null = null;

  prepare(mode: MarkdownViewportMode): void {
    if (this.active?.mode === mode) {
      if (!this.stopRestoring) this.pending = null;
      return;
    }
    const previous = this.handoff;
    const unchanged = this.active && previous?.key === this.active.key
      && Math.abs(this.active.element.scrollTop - previous.scrollTop) <= 1
      && this.active.element.clientWidth === previous.width
      && Object.is(this.active.version?.(), previous.version);
    this.pending ??= unchanged ? previous.anchor : this.active?.capture() ?? null;
    this.stopRestoring?.();
  }

  prepareNormalization(markdown: string, normalized: string, frontmatter: MarkdownFrontmatterMode): void {
    this.prepare('rich');
    if (!this.pending || this.pending.atStart) return;
    const before = createMarkdownViewPositionMap(markdown, frontmatter);
    const after = createMarkdownViewPositionMap(normalized, frontmatter);
    const position = before.sourceToRich(this.pending.sourceOffset);
    const offset = position === null ? null : after.richToSource(position);
    if (offset !== null) this.pending = { sourceOffset: offset, viewportOffset: this.pending.viewportOffset };
  }

  /** An explicit link wins; a previously handled link cannot steal a later handoff. */
  claimNavigation(requestId: string): boolean {
    if (this.navigationRequest === requestId) return false;
    this.navigationRequest = requestId;
    this.pending = null;
    this.handoff = null;
    this.stopRestoring?.();
    return true;
  }

  attach(adapter: MarkdownViewportAdapter): () => void {
    this.stopRestoring?.();
    this.active = adapter;
    const anchor = this.pending;
    if (anchor) {
      let stopped = false;
      let correcting = false;
      let cancelRestore: (() => void) | void;
      let restoredScrollTop = adapter.element.scrollTop;
      const previousVisibility = adapter.element.style.visibility;
      const previousOverflowAnchor = adapter.element.style.overflowAnchor;
      // Browser anchoring and our text-anchor correction must not both move
      // the viewport when images or node views finish their layout.
      adapter.element.style.overflowAnchor = 'none';
      adapter.element.style.visibility = 'hidden';
      const reveal = () => { adapter.element.style.visibility = previousVisibility; };
      const restore = () => {
        if (stopped || correcting || this.active !== adapter) return;
        correcting = true;
        cancelRestore = adapter.restore(anchor, updated => {
          correcting = false;
          restoredScrollTop = adapter.element.scrollTop;
          if (!stopped && this.active === adapter) {
            this.handoff = { key: adapter.key, anchor: updated ?? anchor, scrollTop: restoredScrollTop,
              width: adapter.element.clientWidth, version: adapter.version?.() };
            if (this.pending === anchor) this.pending = null;
            reveal();
          }
        }, () => !stopped && this.active === adapter);
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        cancelRestore?.();
        reveal();
        adapter.element.style.overflowAnchor = previousOverflowAnchor;
        observer?.disconnect();
        clearTimeout(timeout);
        for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
          adapter.element.removeEventListener(event, interrupt, true);
        }
        adapter.element.removeEventListener('scroll', scrolled, true);
        if (this.stopRestoring === stop) this.stopRestoring = null;
      };
      const interrupt = () => { this.pending = null; this.handoff = null; stop(); };
      const scrolled = () => {
        if (!correcting && Math.abs(adapter.element.scrollTop - restoredScrollTop) > 1) interrupt();
      };
      // Image/math/embedded content may finish layout after the initial handoff.
      // The correction is bounded and yields immediately to user interaction.
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore);
      const timeout = setTimeout(stop, 1_500);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        adapter.element.addEventListener(event, interrupt, true);
      }
      adapter.element.addEventListener('scroll', scrolled, true);
      this.stopRestoring = stop;
      restore();
      observer?.observe(adapter.content);
    }
    return () => {
      if (this.active !== adapter) return;
      const previous = this.handoff;
      const unchanged = previous?.key === adapter.key
        && Math.abs(adapter.element.scrollTop - previous.scrollTop) <= 1
        && adapter.element.clientWidth === previous.width
        && Object.is(adapter.version?.(), previous.version);
      this.pending ??= unchanged ? previous.anchor : adapter.capture();
      this.stopRestoring?.();
      this.active = null;
    };
  }
}

/** Keep the registered view stable while capture reads the latest committed document. */
export function useMarkdownViewportAdapter(controller: MarkdownModeViewport | undefined, adapter: MarkdownViewportAdapter | null): void {
  const latest = useRef(adapter);
  useLayoutEffect(() => { latest.current = adapter; });
  const key = adapter?.key;
  useLayoutEffect(() => {
    const current = latest.current;
    if (!controller || !current) return;
    return controller.attach({ ...current,
      version: () => latest.current?.version?.(),
      capture: () => latest.current?.capture() ?? null,
      restore: (anchor, done, current) => latest.current?.restore(anchor, done, current),
    });
  }, [controller, key]);
}

const SOURCE_FROM = 'data-markdown-source-from';
const SOURCE_TO = 'data-markdown-source-to';
const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value));
const hasRichRange = (block: MarkdownViewBlock): block is MarkdownViewBlock & { richFrom: number; richTo: number } =>
  block.richFrom !== null && block.richTo !== null;

function sourceOffsetForAnchor(anchor: MarkdownViewportAnchor, map: ReturnType<typeof createMarkdownViewPositionMap>): number {
  if (anchor.blockId) {
    const block = map.blocks.find(item => item.blockId === anchor.blockId);
    if (block && hasRichRange(block)) return map.richToSource(Math.min(block.richTo - 1, block.richFrom + 1 + (anchor.blockOffset ?? 0))) ?? block.sourceFrom;
  }
  return clamp(anchor.sourceOffset, map.sourceLength);
}

function textOffsetAtPoint(element: HTMLElement, x: number, y: number): number | null {
  const doc = element.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = doc.caretPositionFromPoint?.(x, y);
  const range = caret ? null : doc.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset;
  if (!node || offset === undefined || !element.contains(node)) return null;
  let total = 0;
  for (const unit of readingTextUnits(element)) {
    if (unit.node === node) return total + Math.min(offset, unit.length);
    if (unit.node.contains(node)) return total;
    if (unit.node.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) return total;
    total += unit.length;
  }
  return null;
}

/** Rendered math/mentions have many DOM characters but one document position. */
function readingTextUnits(element: HTMLElement): { node: Node; length: number; atom: boolean }[] {
  const result: { node: Node; length: number; atom: boolean }[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      // Markdown's hard break renderer emits a BR and a formatting newline.
      if (node.textContent === '\n' && (node.previousSibling as Element | null)?.nodeName === 'BR') return;
      result.push({ node, length: node.textContent?.length ?? 0, atom: false });
    } else if (node instanceof HTMLElement && node.matches('br, [data-markdown-atom], .katex, [data-canvas-mention-user-id]')) {
      result.push({ node, length: 1, atom: true });
    } else for (const child of node.childNodes) visit(child);
  };
  for (const child of element.childNodes) visit(child);
  return result;
}

function textCoordinates(element: HTMLElement, offset: number): DOMRect | null {
  let remaining = offset;
  for (const { node, length, atom } of readingTextUnits(element)) {
    if (remaining >= length && length > 0) { remaining -= length; continue; }
    if (atom) return (node as HTMLElement).getBoundingClientRect();
    const range = element.ownerDocument.createRange();
    range.setStart(node, Math.min(remaining, length));
    range.setEnd(node, Math.min(remaining + 1, length));
    const rect = range.getBoundingClientRect();
    if (rect.height) return rect;
  }
  return null;
}

export function createReadingViewportAdapter(element: HTMLElement, markdown: string, frontmatter: MarkdownFrontmatterMode,
  richDocument?: JSONContent | null): MarkdownViewportAdapter {
  const content = element.querySelector<HTMLElement>('[data-markdown-position-root]') ?? element;
  let cached: ReturnType<typeof createMarkdownViewPositionMap> | undefined;
  const map = () => cached ??= createMarkdownViewPositionMap(markdown, frontmatter, richDocument);
  const marked = () => Array.from(element.querySelectorAll<HTMLElement>(`[${SOURCE_FROM}]`))
    .filter(node => node.closest('[data-markdown-position-root]') === content || node.dataset.markdownMetadata === 'true');
  return { key: element, mode: 'read', element, content, version: () => markdown,
    capture() {
      const viewport = element.getBoundingClientRect();
      if (!viewport.height) return null;
      if (element.scrollTop <= 1) return { sourceOffset: 0, viewportOffset: 0, atStart: true };
      const y = viewport.top + 4;
      const candidates = marked().filter(node => { const rect = node.getBoundingClientRect(); return rect.bottom > y && rect.top < viewport.bottom; });
      candidates.sort((left, right) => {
        const a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
        const aContains = a.top <= y, bContains = b.top <= y;
        if (aContains !== bContains) return aContains ? -1 : 1;
        if (!aContains && a.top !== b.top) return a.top - b.top;
        return Number(left.getAttribute(SOURCE_TO)) - Number(left.getAttribute(SOURCE_FROM))
          - (Number(right.getAttribute(SOURCE_TO)) - Number(right.getAttribute(SOURCE_FROM)));
      });
      const block = candidates[0] ?? marked().at(-1);
      if (!block) return { sourceOffset: 0, viewportOffset: 0 };
      const rect = block.getBoundingClientRect();
      const index = map();
      const from = Number(block.getAttribute(SOURCE_FROM));
      const x = Math.max(viewport.left + 8, rect.left + 2);
      let textOffset = rect.top <= y ? textOffsetAtPoint(block, x, y) : null;
      let coordinates = textOffset === null ? rect : textCoordinates(block, textOffset) ?? rect;
      if (coordinates.top < viewport.top && textOffset !== null) {
        textOffset = textOffsetAtPoint(block, x, coordinates.bottom + 1) ?? textOffset;
        coordinates = textCoordinates(block, textOffset) ?? coordinates;
      }
      const sourceOffset = textOffset === null ? from : index.textToSource(from, textOffset) ?? from;
      const mapped = index.blocks.filter(hasRichRange).filter(item => item.sourceFrom <= sourceOffset && item.sourceTo >= sourceOffset && item.blockId)
        .sort((a, b) => a.sourceTo - a.sourceFrom - (b.sourceTo - b.sourceFrom))[0];
      const rich = index.sourceToRich(sourceOffset);
      return { sourceOffset, viewportOffset: coordinates.top - viewport.top,
        blockId: mapped?.blockId ?? undefined,
        blockOffset: mapped && rich !== null ? Math.max(0, rich - mapped.richFrom - 1) : undefined };
    },
    restore(anchor, done, current) {
      if (!current()) return;
      if (anchor.atStart) { element.scrollTop = 0; done(); return; }
      const index = map();
      const offset = sourceOffsetForAnchor(anchor, index);
      const blocks = marked();
      const containing = blocks.filter(node => Number(node.getAttribute(SOURCE_FROM)) <= offset && Number(node.getAttribute(SOURCE_TO)) >= offset)
        .sort((a, b) => Number(a.getAttribute(SOURCE_TO)) - Number(a.getAttribute(SOURCE_FROM))
          - (Number(b.getAttribute(SOURCE_TO)) - Number(b.getAttribute(SOURCE_FROM))));
      const block = containing[0] ?? blocks.find(node => Number(node.getAttribute(SOURCE_FROM)) >= offset) ?? blocks.at(-1);
      if (block) {
        const text = index.sourceToText(offset);
        const rect = text && text.sourceFrom >= Number(block.getAttribute(SOURCE_FROM))
          && text.sourceFrom <= Number(block.getAttribute(SOURCE_TO))
          ? textCoordinates(block, text.textOffset) ?? block.getBoundingClientRect() : block.getBoundingClientRect();
        element.scrollTop += rect.top - element.getBoundingClientRect().top - anchor.viewportOffset;
      }
      done();
    },
  };
}

export function createRichViewportAdapter(editor: Editor, element: HTMLElement, markdown: string,
  frontmatter: MarkdownFrontmatterMode): MarkdownViewportAdapter {
  let cached: ReturnType<typeof createMarkdownViewPositionMap> | undefined;
  let document = editor.state.doc;
  const map = () => {
    if (!cached || document !== editor.state.doc) {
      document = editor.state.doc;
      cached = createMarkdownViewPositionMap(markdown, frontmatter, document.toJSON());
    }
    return cached;
  };
  return { key: editor, mode: 'rich', element, content: editor.view.dom, version: () => editor.state.doc,
    capture() {
      if (editor.isDestroyed) return null;
      const viewport = element.getBoundingClientRect();
      if (!viewport.height || !editor.view.dom.ownerDocument.elementFromPoint) return null;
      if (element.scrollTop <= 1) return { sourceOffset: 0, viewportOffset: 0, atStart: true };
      const body = editor.view.dom.getBoundingClientRect();
      const top = Math.max(body.top + 2, viewport.top + 4);
      const blocks = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('p, h1, h2, h3, h4, h5, h6, pre'));
      const blockElement = blocks.find(node => { const rect = node.getBoundingClientRect(); return rect.top <= top && rect.bottom > top; })
        ?? blocks.find(node => node.getBoundingClientRect().top >= top) ?? editor.view.dom;
      const padding = Number.parseFloat(getComputedStyle(blockElement).paddingLeft) || 0;
      const left = Math.max(blockElement.getBoundingClientRect().left + padding + 2, viewport.left + 8);
      const at = editor.view.posAtCoords({ left, top: Math.max(top, blockElement.getBoundingClientRect().top + 2) });
      let position = at?.pos ?? editor.state.doc.content.size;
      let coordinates = editor.view.coordsAtPos(position);
      if (coordinates.top < viewport.top) {
        position = editor.view.posAtCoords({ left, top: coordinates.bottom + 1 })?.pos ?? position;
        coordinates = editor.view.coordsAtPos(position);
      }
      const index = map();
      const block = index.blocks.filter(hasRichRange).filter(item => item.richFrom <= position && item.richTo >= position && item.blockId)
        .sort((a, b) => a.richTo - a.richFrom - (b.richTo - b.richFrom))[0];
      return { sourceOffset: index.richToSource(position) ?? 0,
        viewportOffset: coordinates.top - viewport.top,
        blockId: block?.blockId ?? undefined,
        blockOffset: block ? Math.max(0, position - block.richFrom - 1) : undefined };
    },
    restore(anchor, done, current) {
      if (!current()) return;
      if (!editor.isDestroyed) {
        const index = map();
        if (anchor.atStart || anchor.sourceOffset < index.bodyOffset) { element.scrollTop = 0; done(); return; }
        const position = index.sourceToRich(sourceOffsetForAnchor(anchor, index));
        if (position !== null) element.scrollTop += editor.view.coordsAtPos(clamp(position, editor.state.doc.content.size)).top
          - element.getBoundingClientRect().top - anchor.viewportOffset;
      }
      done();
    },
  };
}

export function createSourceViewportAdapter(view: EditorView): MarkdownViewportAdapter {
  return { key: view, mode: 'source', element: view.scrollDOM, content: view.contentDOM, version: () => view.state.doc,
    capture() {
      const viewport = view.scrollDOM.getBoundingClientRect();
      if (!viewport.height) return null;
      if (view.scrollDOM.scrollTop <= 1) return { sourceOffset: 0, viewportOffset: 0, atStart: true };
      const block = view.lineBlockAtHeight(viewport.top + 4 - view.documentTop);
      const x = Math.max(view.contentDOM.getBoundingClientRect().left + 2, viewport.left + 8);
      let offset = view.posAtCoords({ x, y: viewport.top + 4 }, false) ?? block.from;
      let rect = view.coordsAtPos(offset);
      if (rect && rect.top < viewport.top) {
        offset = view.posAtCoords({ x, y: rect.bottom + 1 }, false) ?? offset;
        rect = view.coordsAtPos(offset);
      }
      return { sourceOffset: offset, viewportOffset: rect ? rect.top - viewport.top : 0 };
    },
    restore(anchor, done, current) {
      if (!current()) return;
      if (anchor.atStart) { view.scrollDOM.scrollTop = 0; done(); return; }
      const offset = clamp(anchor.sourceOffset, view.state.doc.length);
      const margin = Math.max(0, anchor.viewportOffset);
      const request = { offset, margin, coarseConsumed: false, current };
      pendingSourceScrolls.set(view, request);
      view.dispatch({ effects: EditorView.scrollIntoView(offset, { y: 'start', yMargin: margin }) });
      // CodeMirror consumes its coarse scroll target AFTER measure writes.
      // Measure on the following frame so it cannot overwrite the signed offset.
      view.requestMeasure({
        read: () => null,
        write: () => {
          requestAnimationFrame(() => {
            if (!current()) return;
            view.requestMeasure({
              read: () => current() ? view.coordsAtPos(clamp(request.offset, view.state.doc.length)) : null,
              write: rect => {
                if (!current()) return;
                if (rect) view.scrollDOM.scrollTop += rect.top - view.scrollDOM.getBoundingClientRect().top - anchor.viewportOffset;
                if (pendingSourceScrolls.get(view) === request) pendingSourceScrolls.delete(view);
                done(request.offset === anchor.sourceOffset ? anchor
                  : { sourceOffset: request.offset, viewportOffset: anchor.viewportOffset });
              },
            });
          });
        },
      });
      return () => {
        if (request.coarseConsumed && pendingSourceScrolls.get(view) === request) pendingSourceScrolls.delete(view);
      };
    },
  };
}
