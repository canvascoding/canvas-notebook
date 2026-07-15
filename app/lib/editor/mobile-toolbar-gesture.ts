export type MobileToolbarPoint = {
  clientX: number;
  clientY: number;
};

export type MobileToolbarBounds = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export const MOBILE_TOOLBAR_PRESS_SLOP_PX = 12;

export function hasMobileToolbarPressMoved(
  start: MobileToolbarPoint,
  current: MobileToolbarPoint,
  slop = MOBILE_TOOLBAR_PRESS_SLOP_PX,
): boolean {
  const deltaX = current.clientX - start.clientX;
  const deltaY = current.clientY - start.clientY;
  return (deltaX * deltaX) + (deltaY * deltaY) > slop * slop;
}

export function isMobileToolbarReleaseInside(
  bounds: MobileToolbarBounds,
  point: MobileToolbarPoint,
): boolean {
  return point.clientX >= bounds.left
    && point.clientX <= bounds.right
    && point.clientY >= bounds.top
    && point.clientY <= bounds.bottom;
}
