export type BlockElementRect = { top: number; left: number; width: number; height: number };

/** Coordinates in the scroll container's padding box, where controls are positioned. */
export function blockElementRect(container: HTMLElement, block: HTMLElement): BlockElementRect | null {
  for (let element: HTMLElement | null = block; element; element = element.parentElement) {
    if (element.hidden) return null;
    if (element !== block && element.tagName === 'DETAILS' && !element.hasAttribute('open')) {
      const summary = Array.from(element.children).find(child => child.tagName === 'SUMMARY');
      if (!summary?.contains(block)) return null;
    }
    if (element === container) break;
  }
  if (block.getClientRects().length === 0) return null;
  const parent = container.getBoundingClientRect();
  const rect = block.getBoundingClientRect();
  const result = {
    top: rect.top - parent.top - container.clientTop + container.scrollTop,
    left: rect.left - parent.left - container.clientLeft + container.scrollLeft,
    width: rect.width, height: rect.height,
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

/** Coalesce layout signals without observing the overlays that we update. */
export function observeBlockControlLayout(container: HTMLElement, editorDom: HTMLElement, update: () => void): () => void {
  const window = container.ownerDocument.defaultView!;
  let disposed = false;
  let frame: number | null = null;
  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (!disposed) update();
    });
  };
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  resize?.observe(container);
  resize?.observe(editorDom);
  const mutation = new MutationObserver(schedule);
  mutation.observe(editorDom, { attributes: true, childList: true, characterData: true, subtree: true });
  for (let parent = editorDom.parentElement; parent && container.contains(parent); parent = parent.parentElement) {
    mutation.observe(parent, { attributes: true });
    resize?.observe(parent);
    if (parent === container) break;
  }
  container.addEventListener('scroll', schedule, true);
  editorDom.addEventListener('load', schedule, true);
  editorDom.addEventListener('toggle', schedule, true);
  window.addEventListener('resize', schedule);
  const fonts = container.ownerDocument.fonts;
  fonts?.addEventListener('loadingdone', schedule);
  schedule();
  return () => {
    disposed = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    resize?.disconnect();
    mutation.disconnect();
    container.removeEventListener('scroll', schedule, true);
    editorDom.removeEventListener('load', schedule, true);
    editorDom.removeEventListener('toggle', schedule, true);
    window.removeEventListener('resize', schedule);
    fonts?.removeEventListener('loadingdone', schedule);
  };
}
