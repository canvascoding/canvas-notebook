type VerticalRect = { top: number; bottom: number };
type ViewportRect = VerticalRect & { left: number; right: number };

/** Preserve a visible caret; reveal a hidden one without centering the document. */
export function mobileCaretScrollDelta(caret: VerticalRect, visible: VerticalRect): number {
  const height = visible.bottom - visible.top;
  if (height <= 0) return 0;
  if (caret.bottom - caret.top > height && caret.top < visible.bottom && caret.bottom > visible.top) return 0;
  if (caret.top < visible.top) return caret.top - visible.top - Math.min(48, height / 4);
  if (caret.bottom > visible.bottom) return caret.bottom - visible.bottom + Math.min(12, height / 4);
  return 0;
}

export interface MobileEditorViewport {
  scrollToCaret: (caret?: ViewportRect | null) => boolean;
  destroy: () => void;
}

/** Local to one editor: never move window scroll, selection, focus or history. */
export function createMobileEditorViewport(options: {
  pane: HTMLElement;
  scroller: HTMLElement;
  content: HTMLElement;
  readCaret: () => ViewportRect | null;
  isComposing: () => boolean;
}): MobileEditorViewport {
  const { pane, scroller, content } = options;
  const win = pane.ownerDocument.defaultView;
  const viewport = win?.visualViewport;
  const media = win?.matchMedia?.('(max-width: 767px), (hover: none) and (pointer: coarse)');
  const property = '--canvas-editor-keyboard-inset';
  const previousInset = pane.style.getPropertyValue(property);
  let frame: number | null = null;
  let revealCaret = false;
  let destroyed = false;

  const active = () => Boolean(!destroyed && media?.matches && viewport && Math.abs(viewport.scale - 1) < 0.01
    && content.isConnected && content.contains(content.ownerDocument.activeElement));

  const updateLayout = () => {
    const rect = pane.getBoundingClientRect();
    // Safari can pan the visual viewport as well as reduce its height. Its
    // bottom edge, rather than keyboard height alone, clips this particular pane.
    let bottom = rect.bottom;
    if (active() && viewport) {
      bottom = Math.min(bottom, viewport.offsetTop + viewport.height);
      for (const toolbar of pane.ownerDocument.querySelectorAll<HTMLElement>('.tiptap-mobile-toolbar-visible')) {
        const box = toolbar.getBoundingClientRect();
        if (box.height > 0 && box.right > rect.left && box.left < rect.right
          && box.bottom > Math.max(rect.top, viewport.offsetTop) && box.top < bottom) bottom = Math.max(rect.top, box.top - 8);
      }
    }
    // Reserve toolbar space in layout too, so EOF has enough scroll range.
    // A scroll margin alone cannot reveal the last Source line beyond its end.
    const inset = Math.min(Math.max(0, rect.bottom - bottom), Math.max(0, rect.height - 48));
    const next = `${Math.round(inset)}px`;
    if (pane.style.getPropertyValue(property) !== next) pane.style.setProperty(property, next);
  };

  const visibleBounds = (): VerticalRect | null => {
    if (!viewport) return null;
    const rect = scroller.getBoundingClientRect();
    const top = Math.max(rect.top + scroller.clientTop, viewport.offsetTop);
    let bottom = Math.min(rect.bottom, viewport.offsetTop + viewport.height);
    // Measure the rendered toolbar. Its existing iOS positioning contract is
    // independent from the coordinates used to keep the caret visible here.
    for (const toolbar of pane.ownerDocument.querySelectorAll<HTMLElement>('.tiptap-mobile-toolbar-visible')) {
      const box = toolbar.getBoundingClientRect();
      if (box.height > 0 && box.right > rect.left && box.left < rect.right && box.bottom > top && box.top < bottom) {
        bottom = Math.max(top, box.top - 8);
      }
    }
    return bottom > top ? { top, bottom } : null;
  };

  const scrollToCaret = (caret?: ViewportRect | null): boolean => {
    if (!active()) return false;
    updateLayout();
    // Let the IME finish before changing the geometry around its composition.
    if (options.isComposing()) return true;
    const visible = visibleBounds();
    const currentCaret = caret ?? options.readCaret();
    if (!visible || !currentCaret) return false;
    const delta = mobileCaretScrollDelta(currentCaret, visible);
    if (delta) scroller.scrollTop += delta;
    return true;
  };

  const schedule = (ensureVisible: boolean) => {
    if (!win || destroyed) return;
    revealCaret ||= ensureVisible;
    if (frame !== null) return;
    frame = win.requestAnimationFrame(() => {
      frame = null;
      const reveal = revealCaret;
      revealCaret = false;
      updateLayout();
      if (reveal) scrollToCaret();
    });
  };
  const changed = () => schedule(true);
  const panned = () => schedule(false);
  const browsing = () => { revealCaret = false; };
  const observer = win && typeof win.ResizeObserver !== 'undefined' ? new win.ResizeObserver(panned) : null;
  observer?.observe(pane);
  // Deliberately do not reveal the caret on scroll/selectionchange. Browsing
  // the surrounding text must retain the position chosen by the user.
  content.addEventListener('input', changed);
  content.addEventListener('compositionend', changed);
  scroller.addEventListener('wheel', browsing, { passive: true });
  scroller.addEventListener('touchmove', browsing, { passive: true });
  pane.addEventListener('focusin', changed);
  pane.addEventListener('focusout', panned);
  viewport?.addEventListener('resize', changed);
  viewport?.addEventListener('scroll', panned);
  win?.addEventListener('resize', changed);
  media?.addEventListener('change', changed);
  schedule(false);

  return { scrollToCaret, destroy() {
    destroyed = true;
    if (frame !== null) win?.cancelAnimationFrame(frame);
    observer?.disconnect();
    content.removeEventListener('input', changed);
    content.removeEventListener('compositionend', changed);
    scroller.removeEventListener('wheel', browsing);
    scroller.removeEventListener('touchmove', browsing);
    pane.removeEventListener('focusin', changed);
    pane.removeEventListener('focusout', panned);
    viewport?.removeEventListener('resize', changed);
    viewport?.removeEventListener('scroll', panned);
    win?.removeEventListener('resize', changed);
    media?.removeEventListener('change', changed);
    if (previousInset) pane.style.setProperty(property, previousInset);
    else pane.style.removeProperty(property);
  } };
}
