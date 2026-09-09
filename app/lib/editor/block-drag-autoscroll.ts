type DragPointer = { clientX: number; clientY: number };

export type BlockDragAutoscroll = {
  update: (pointer: DragPointer | null) => void;
  stop: () => void;
  destroy: () => void;
};

/** Scroll only this editor, in the visible part of its vertical edge zones. */
export function createBlockDragAutoscroll(container: HTMLElement, active: () => boolean, onScroll: () => void): BlockDragAutoscroll {
  const window = container.ownerDocument.defaultView!;
  let pointer: DragPointer | null = null;
  let frame: number | null = null;
  let previousTime: number | null = null;
  let generation = 0;
  let disposed = false;
  const velocity = () => {
    if (!pointer || !active() || container.ownerDocument.hidden) return 0;
    const rect = container.getBoundingClientRect();
    const top = Math.max(0, rect.top + container.clientTop);
    const bottom = Math.min(window.innerHeight, rect.top + container.clientTop + container.clientHeight);
    const left = Math.max(0, rect.left + container.clientLeft);
    const right = Math.min(window.innerWidth, rect.left + container.clientLeft + container.clientWidth);
    if (bottom <= top || right <= left || pointer.clientX < left || pointer.clientX > right
      || pointer.clientY < top || pointer.clientY > bottom) return 0;
    const edge = Math.min(48, (bottom - top) / 3);
    if (pointer.clientY < top + edge) return -0.6 * ((top + edge - pointer.clientY) / edge) ** 2;
    if (pointer.clientY > bottom - edge) return 0.6 * ((pointer.clientY - bottom + edge) / edge) ** 2;
    return 0;
  };
  const stop = () => {
    generation++;
    pointer = null;
    previousTime = null;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
  };
  const schedule = () => {
    if (disposed || frame !== null) return;
    const currentGeneration = generation;
    frame = window.requestAnimationFrame(time => {
      if (disposed || generation !== currentGeneration) return;
      frame = null;
      const speed = velocity();
      if (!speed) { stop(); return; }
      const elapsed = previousTime === null ? 1000 / 60 : Math.min(40, Math.max(0, time - previousTime));
      previousTime = time;
      const before = container.scrollTop;
      const end = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = Math.max(0, Math.min(end, before + speed * elapsed));
      if (container.scrollTop === before) { stop(); return; }
      onScroll();
      if (generation === currentGeneration && !disposed) schedule();
    });
  };
  return {
    update(next) {
      if (disposed) return;
      pointer = next;
      if (!velocity()) stop();
      else schedule();
    },
    stop,
    destroy() { disposed = true; stop(); },
  };
}
