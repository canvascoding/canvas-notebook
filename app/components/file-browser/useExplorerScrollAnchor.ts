'use client';

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export interface ExplorerAnchor { path: string; offset: number }
export function captureExplorerAnchor(surface: HTMLElement): ExplorerAnchor | null {
  const bounds = surface.getBoundingClientRect();
  for (const row of surface.querySelectorAll<HTMLElement>('[data-file-path]')) {
    const rect = row.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { path: row.dataset.filePath!, offset: rect.top - bounds.top };
    }
  }
  return null;
}

export function restoreExplorerAnchor(surface: HTMLElement, anchor: ExplorerAnchor) {
  const row = Array.from(surface.querySelectorAll<HTMLElement>('[data-file-path]'))
    .find((entry) => entry.dataset.filePath === anchor.path);
  if (!row) return;
  const delta = row.getBoundingClientRect().top - surface.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(delta) > 0.5) surface.scrollTop += delta;
}

export function useExplorerScrollAnchor(ref: RefObject<HTMLDivElement | null>, context: string, revision: unknown) {
  const previous = useRef<{
    surface: HTMLElement; context: string; revision: unknown;
    anchor: ExplorerAnchor | null; onScroll: () => void;
  } | null>(null);
  // The surface can mount after restoration without changing the data revision.
  useLayoutEffect(() => {
    const surface = ref.current;
    const entry = previous.current;
    if (entry && (entry.surface !== surface || entry.context !== context)) {
      entry.surface.removeEventListener('scroll', entry.onScroll);
      previous.current = null;
    }
    if (!surface) return;
    if (previous.current) {
      if (previous.current.revision !== revision && previous.current.anchor) {
        restoreExplorerAnchor(surface, previous.current.anchor);
      }
      previous.current.revision = revision;
      previous.current.anchor = captureExplorerAnchor(surface);
      return;
    }
    const onScroll = () => {
      if (previous.current?.surface === surface) previous.current.anchor = captureExplorerAnchor(surface);
    };
    previous.current = { surface, context, revision, anchor: captureExplorerAnchor(surface), onScroll };
    surface.addEventListener('scroll', onScroll, { passive: true });
  });
  useEffect(() => {
    return () => {
      const entry = previous.current;
      entry?.surface.removeEventListener('scroll', entry.onScroll);
      previous.current = null;
    };
  }, []);
}
