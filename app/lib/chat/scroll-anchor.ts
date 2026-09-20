export type ChatScrollAnchor = {
  element: HTMLElement;
  top: number;
};

export function captureChatScrollAnchor(
  container: HTMLElement,
  content: HTMLElement,
): ChatScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  for (const child of content.children) {
    if (!(child instanceof HTMLElement)) continue;
    const rect = child.getBoundingClientRect();
    if (rect.bottom > containerTop + 1) {
      return { element: child, top: rect.top };
    }
  }
  return null;
}

export function restoreChatScrollAnchor(
  container: HTMLElement,
  content: HTMLElement,
  anchor: ChatScrollAnchor | null,
): boolean {
  if (!anchor || !anchor.element.isConnected || !content.contains(anchor.element)) {
    return false;
  }

  const delta = anchor.element.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) < 0.5) {
    return false;
  }

  container.scrollTop += delta;
  return true;
}
