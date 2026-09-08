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
  const previous = useRef<{ context: string; anchor: ExplorerAnchor | null } | null>(null);
  useLayoutEffect(() => {
    const surface = ref.current?.closest<HTMLElement>('[data-file-scroll-container]') ?? ref.current;
    if (!surface) return;
    if (previous.current?.context === context && previous.current.anchor) restoreExplorerAnchor(surface, previous.current.anchor);
    previous.current = { context, anchor: captureExplorerAnchor(surface) };
  }, [context, ref, revision]);
  useEffect(() => {
    const surface = ref.current?.closest<HTMLElement>('[data-file-scroll-container]') ?? ref.current;
    if (!surface) return;
    const onScroll = () => { previous.current = { context, anchor: captureExplorerAnchor(surface) }; };
    surface.addEventListener('scroll', onScroll, { passive: true });
    return () => surface.removeEventListener('scroll', onScroll);
  }, [context, ref]);
}
