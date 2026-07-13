export interface MarqueePoint {
  x: number;
  y: number;
}

export interface MarqueeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MarqueeItemRect extends MarqueeRect {
  path: string;
}

export function normalizeMarqueeRect(start: MarqueePoint, end: MarqueePoint): MarqueeRect {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x),
    bottom: Math.max(start.y, end.y),
  };
}

export function marqueeRectsIntersect(left: MarqueeRect, right: MarqueeRect): boolean {
  return (
    left.left <= right.right
    && left.right >= right.left
    && left.top <= right.bottom
    && left.bottom >= right.top
  );
}

export function getIntersectingMarqueePaths(
  items: Iterable<MarqueeItemRect>,
  selectionRect: MarqueeRect,
): Set<string> {
  const paths = new Set<string>();
  for (const item of items) {
    if (marqueeRectsIntersect(item, selectionRect)) {
      paths.add(item.path);
    }
  }
  return paths;
}

export function mergeMarqueeSelection(
  basePaths: Iterable<string>,
  intersectingPaths: Iterable<string>,
  additive: boolean,
): Set<string> {
  const paths = additive ? new Set(basePaths) : new Set<string>();
  for (const path of intersectingPaths) {
    paths.add(path);
  }
  return paths;
}
