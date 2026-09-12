import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

const caretSelector = '.collaboration-carets__caret';
const clipsOverflow = /^(auto|scroll|hidden|clip)$/;

function placeCaretLabel(cursor: HTMLElement) {
  const win = cursor.ownerDocument.defaultView;
  const label = cursor.querySelector<HTMLElement>('.collaboration-carets__label');
  if (!win || !label || !cursor.isConnected) return;
  const shell = cursor.closest<HTMLElement>('.tiptap-editor-shell');
  if (!shell) return;
  const viewport = win.visualViewport;
  const shellRect = shell.getBoundingClientRect();
  let left = Math.max(shellRect.left, viewport?.offsetLeft ?? 0);
  let right = Math.min(shellRect.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? win.innerWidth));
  let top = Math.max(shellRect.top, viewport?.offsetTop ?? 0);
  let bottom = Math.min(shellRect.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? win.innerHeight));
  for (let parent = cursor.parentElement; parent; parent = parent.parentElement) {
    const style = win.getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    if (clipsOverflow.test(style.overflowX)) {
      left = Math.max(left, rect.left + parent.clientLeft);
      right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth);
    }
    if (clipsOverflow.test(style.overflowY)) {
      top = Math.max(top, rect.top + parent.clientTop);
      bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight);
    }
  }
  if (right <= left || bottom <= top) return;
  left += 4;
  right -= 4;
  top += 4;
  bottom -= 4;
  label.style.maxWidth = `min(12rem, ${Math.max(0, right - left)}px)`;
  // Offset dimensions exclude the arrival animation's temporary transform.
  const width = label.offsetWidth;
  const height = label.offsetHeight;
  const rect = cursor.getBoundingClientRect();
  const spaceLeft = rect.left - left;
  const spaceRight = right - rect.right;
  const side = spaceRight >= width + 12 || spaceRight >= spaceLeft ? 'right' : 'left';
  const below = rect.top - top < height + 10 && bottom - rect.bottom > rect.top - top;
  const desiredLeft = rect.left + rect.width / 2 - (side === 'left' ? width : 0);
  const desiredTop = below ? rect.bottom + 10 : rect.top - height - 10;
  label.style.left = `${Math.max(left, Math.min(desiredLeft, right - width)) - rect.left}px`;
  label.style.top = `${Math.max(top, Math.min(desiredTop, bottom - height)) - rect.top}px`;
  label.style.right = 'auto';
  label.style.bottom = 'auto';
  cursor.dataset.labelSide = side;
  cursor.dataset.labelVertical = below ? 'below' : 'above';
  cursor.classList.toggle('collaboration-carets__caret--label-left', side === 'left');
  cursor.classList.toggle('collaboration-carets__caret--label-below', below);
}

export const CollaborationCaretLayout = Extension.create({
  name: 'canvasCollaborationCaretLayout',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('canvas-collaboration-caret-layout'),
      view(view) {
        const doc = view.dom.ownerDocument;
        const win = doc.defaultView;
        if (!win) return {};
        let active = true;
        let frame: number | null = null;
        const schedule = () => {
          if (!active || frame !== null) return;
          frame = win.requestAnimationFrame(() => {
            frame = null;
            if (!active || view.isDestroyed) return;
            view.dom.querySelectorAll<HTMLElement>(caretSelector).forEach(placeCaretLabel);
          });
        };
        const resize = new win.ResizeObserver(schedule);
        resize.observe(view.dom);
        const viewport = view.dom.closest('[data-testid="markdown-scroll-container"]');
        if (viewport) resize.observe(viewport);
        doc.addEventListener('scroll', schedule, { capture: true, passive: true });
        win.addEventListener('resize', schedule);
        win.visualViewport?.addEventListener('resize', schedule);
        win.visualViewport?.addEventListener('scroll', schedule);
        view.dom.addEventListener('pointerover', schedule);
        schedule();
        return {
          update: schedule,
          destroy() {
            active = false;
            if (frame !== null) win.cancelAnimationFrame(frame);
            resize.disconnect();
            doc.removeEventListener('scroll', schedule, true);
            win.removeEventListener('resize', schedule);
            win.visualViewport?.removeEventListener('resize', schedule);
            win.visualViewport?.removeEventListener('scroll', schedule);
            view.dom.removeEventListener('pointerover', schedule);
          },
        };
      },
    })];
  },
});
