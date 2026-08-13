export type HorizontalBounds = {
  left: number;
  right: number;
};

export function getNotebookTabRevealDelta(
  strip: HorizontalBounds,
  tab: HorizontalBounds,
  padding = 8,
): number {
  const safePadding = Math.max(0, padding);
  const visibleLeft = strip.left + safePadding;
  const visibleRight = strip.right - safePadding;

  if (tab.left < visibleLeft) return tab.left - visibleLeft;
  if (tab.right > visibleRight) return tab.right - visibleRight;
  return 0;
}
