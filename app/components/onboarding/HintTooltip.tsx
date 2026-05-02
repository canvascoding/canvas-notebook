'use client';

import { useCallback, useEffect, useRef, useState, startTransition } from 'react';
import { X } from 'lucide-react';

interface HintTooltipProps {
  title: string;
  description: string;
  targetSelector: string;
  mobileTargetSelector?: string;
  onDismiss: () => void;
  dismissing?: boolean;
}

type Placement = 'top' | 'bottom' | 'left' | 'right';

interface Position {
  top: number;
  left: number;
  placement: Placement;
  arrowOffset: number;
}

const MOBILE_BREAKPOINT = 768;
const VIEWPORT_PADDING = 16;
const TOOLTIP_GAP = 12;
const ARROW_SIZE = 8;
const ARROW_MIN_OFFSET = 16;
const SCROLL_TIMEOUT_MS = 1000;

function getScrollParent(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;
  while (parent) {
    const style = getComputedStyle(parent);
    const overflow = style.overflow + style.overflowY + style.overflowX;
    if (/(auto|scroll)/.test(overflow)) return parent;
    parent = parent.parentElement;
  }
  return null;
}

function waitForScrollEnd(el: HTMLElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let lastTop = el.scrollTop;
    let lastLeft = el.scrollLeft;
    let settleCount = 0;

    const check = () => {
      const currentTop = el.scrollTop;
      const currentLeft = el.scrollLeft;
      if (currentTop === lastTop && currentLeft === lastLeft) {
        settleCount++;
        if (settleCount >= 3) {
          cleanup();
          resolve();
          return;
        }
      } else {
        settleCount = 0;
        lastTop = currentTop;
        lastLeft = currentLeft;
      }
      pollTimer = setTimeout(check, 50);
    };

    const onScrollEnd = () => {
      cleanup();
      resolve();
    };

    let pollTimer: ReturnType<typeof setTimeout>;
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(pollTimer);
      el.removeEventListener('scrollend', onScrollEnd);
    };

    el.addEventListener('scrollend', onScrollEnd, { once: true });
    pollTimer = setTimeout(check, 50);
  });
}

function computePosition(targetEl: HTMLElement, tooltipEl: HTMLElement): Position {
  const targetRect = targetEl.getBoundingClientRect();
  const tooltipRect = tooltipEl.getBoundingClientRect();
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  const tooltipW = tooltipRect.width;
  const tooltipH = tooltipRect.height;

  const spaceAbove = targetRect.top;
  const spaceBelow = viewportH - targetRect.bottom;
  const spaceLeft = targetRect.left;
  const spaceRight = viewportW - targetRect.right;

  const neededVertical = tooltipH + TOOLTIP_GAP + ARROW_SIZE;
  const neededHorizontal = tooltipW + TOOLTIP_GAP + ARROW_SIZE;

  const fits = {
    top: spaceAbove >= neededVertical,
    bottom: spaceBelow >= neededVertical,
    left: spaceLeft >= neededHorizontal,
    right: spaceRight >= neededHorizontal,
  };

  const priority: Placement[] = ['bottom', 'top', 'right', 'left'];
  let placement: Placement = 'bottom';

  for (const p of priority) {
    if (fits[p]) {
      placement = p;
      break;
    }
  }

  if (!fits.top && !fits.bottom && !fits.left && !fits.right) {
    const spaces: Record<Placement, number> = {
      bottom: spaceBelow,
      top: spaceAbove,
      right: spaceRight,
      left: spaceLeft,
    };
    let maxSpace = -1;
    for (const p of priority) {
      if (spaces[p] > maxSpace) {
        maxSpace = spaces[p];
        placement = p;
      }
    }
  }

  let top: number;
  let left: number;

  switch (placement) {
    case 'top':
      top = targetRect.top - tooltipH - TOOLTIP_GAP - ARROW_SIZE;
      left = targetRect.left + targetRect.width / 2 - tooltipW / 2;
      break;
    case 'bottom':
      top = targetRect.bottom + TOOLTIP_GAP + ARROW_SIZE;
      left = targetRect.left + targetRect.width / 2 - tooltipW / 2;
      break;
    case 'left':
      top = targetRect.top + targetRect.height / 2 - tooltipH / 2;
      left = targetRect.left - tooltipW - TOOLTIP_GAP - ARROW_SIZE;
      break;
    case 'right':
      top = targetRect.top + targetRect.height / 2 - tooltipH / 2;
      left = targetRect.right + TOOLTIP_GAP + ARROW_SIZE;
      break;
  }

  left = Math.max(VIEWPORT_PADDING, Math.min(left, viewportW - tooltipW - VIEWPORT_PADDING));
  top = Math.max(VIEWPORT_PADDING, Math.min(top, viewportH - tooltipH - VIEWPORT_PADDING));

  let arrowOffset: number;
  if (placement === 'top' || placement === 'bottom') {
    const targetCenterX = targetRect.left + targetRect.width / 2;
    arrowOffset = targetCenterX - left;
    arrowOffset = Math.max(ARROW_MIN_OFFSET, Math.min(arrowOffset, tooltipW - ARROW_MIN_OFFSET));
  } else {
    const targetCenterY = targetRect.top + targetRect.height / 2;
    arrowOffset = targetCenterY - top;
    arrowOffset = Math.max(ARROW_MIN_OFFSET, Math.min(arrowOffset, tooltipH - ARROW_MIN_OFFSET));
  }

  return { top, left, placement, arrowOffset };
}

export function HintTooltip({
  title,
  description,
  targetSelector,
  mobileTargetSelector,
  onDismiss,
  dismissing,
}: HintTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [visible, setVisible] = useState(false);
  const [isMobileView, setIsMobileView] = useState(false);

  const effectiveSelector = (isMobileView && mobileTargetSelector) ? mobileTargetSelector : targetSelector;

  useEffect(() => {
    const handleResize = () => {
      setIsMobileView(window.innerWidth < MOBILE_BREAKPOINT);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const scrollToTarget = useCallback(async (targetEl: HTMLElement): Promise<void> => {
    const scrollParent = getScrollParent(targetEl);
    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const scrollEl = scrollParent ?? (document.scrollingElement as HTMLElement ?? document.documentElement);
    await waitForScrollEnd(scrollEl, SCROLL_TIMEOUT_MS);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, []);

  const reposition = useCallback(async () => {
    const targetEl = document.querySelector(effectiveSelector);
    const tooltipEl = tooltipRef.current;
    if (!targetEl || !(targetEl instanceof HTMLElement) || !tooltipEl) return;
    const pos = computePosition(targetEl, tooltipEl);
    setPosition(pos);
    setVisible(true);
  }, [effectiveSelector]);

  useEffect(() => {
    if (isMobileView) {
      const targetEl = document.querySelector(effectiveSelector);
      if (targetEl && targetEl instanceof HTMLElement) {
        void scrollToTarget(targetEl);
      }
      const timer = setTimeout(() => setVisible(true), 300);
      return () => clearTimeout(timer);
    }

    let cancelled = false;
    startTransition(() => {
      setVisible(false);
      setPosition(null);
    });

    const init = async () => {
      if (cancelled) return;
      const pollForTarget = (): Promise<HTMLElement | null> => {
        return new Promise((resolve) => {
          let attempts = 0;
          const poll = () => {
            if (cancelled) { resolve(null); return; }
            const el = document.querySelector(effectiveSelector);
            if (el && el instanceof HTMLElement) { resolve(el); return; }
            attempts++;
            if (attempts >= 15) { resolve(null); return; }
            setTimeout(poll, 150);
          };
          setTimeout(poll, 100);
        });
      };

      const targetEl = await pollForTarget();
      const tooltipEl = tooltipRef.current;
      if (!targetEl || !tooltipEl || cancelled) return;
      await scrollToTarget(targetEl);
      if (cancelled) return;
      const pos = computePosition(targetEl, tooltipEl);
      if (cancelled) return;
      setPosition(pos);
      setVisible(true);
    };

    void init();
    return () => { cancelled = true; };
  }, [effectiveSelector, isMobileView, scrollToTarget]);

  useEffect(() => {
    if (!visible || isMobileView) return;
    const targetEl = document.querySelector(effectiveSelector);
    if (!targetEl || !(targetEl instanceof HTMLElement)) return;

    let resizeTimer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void reposition(), 100);
    };
    window.addEventListener('resize', handleResize);

    let observer: ResizeObserver | null = null;
    try {
      observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => void reposition(), 100);
      });
      observer.observe(targetEl);
    } catch { /* ResizeObserver not supported */ }

    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimer);
      observer?.disconnect();
    };
  }, [visible, isMobileView, effectiveSelector, reposition]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDismiss]);

  useEffect(() => {
    if (visible && closeBtnRef.current) closeBtnRef.current.focus();
  }, [visible]);

  useEffect(() => {
    const targetEl = document.querySelector(effectiveSelector);
    if (!targetEl || !(targetEl instanceof HTMLElement)) return;

    const origPosition = targetEl.style.position;
    const origZIndex = targetEl.style.zIndex;
    const origTransition = targetEl.style.transition;
    const origCursor = targetEl.style.cursor;

    if (getComputedStyle(targetEl).position === 'static') {
      targetEl.style.position = 'relative';
    }
    targetEl.style.zIndex = '101';
    targetEl.style.transition = 'box-shadow 0.3s ease';
    targetEl.style.cursor = 'pointer';
    targetEl.classList.add('onboarding-highlight-target');

    const handleClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    };
    targetEl.addEventListener('click', handleClick, true);
    targetEl.addEventListener('pointerdown', (e: Event) => {
      e.stopPropagation();
    }, true);

    return () => {
      targetEl.removeEventListener('click', handleClick, true);
      targetEl.removeEventListener('pointerdown', (e: Event) => { e.stopPropagation(); }, true);
      targetEl.classList.remove('onboarding-highlight-target');
      targetEl.style.zIndex = origZIndex;
      targetEl.style.transition = origTransition;
      targetEl.style.cursor = origCursor;
      if (getComputedStyle(targetEl).position === 'relative' && origPosition === 'static') {
        targetEl.style.position = origPosition;
      }
    };
  }, [effectiveSelector, onDismiss]);

  if (isMobileView) {
    return (
      <>
        <style>{`
          .onboarding-highlight-target {
            box-shadow: 0 0 0 4px rgba(245,158,11,0.5), 0 0 20px rgba(245,158,11,0.3) !important;
            border-radius: 8px !important;
            animation: onboarding-pulse 2s ease-in-out infinite !important;
            cursor: pointer !important;
          }
          @keyframes onboarding-pulse {
            0%, 100% { box-shadow: 0 0 0 4px rgba(245,158,11,0.5), 0 0 20px rgba(245,158,11,0.3); }
            50% { box-shadow: 0 0 0 6px rgba(245,158,11,0.7), 0 0 30px rgba(245,158,11,0.4); }
          }
        `}</style>
        <div className="fixed inset-0 z-[99] bg-black/40" onClick={onDismiss} />
        <div
          className={`fixed inset-x-0 bottom-0 z-[100] transition-transform duration-300 ease-out ${
            visible ? 'translate-y-0' : 'translate-y-full'
          }`}
          role="dialog"
          aria-label={title}
        >
          <div className="relative z-[100] mx-4 mb-4 rounded-xl border-2 border-amber-500/60 bg-popover p-4 shadow-xl shadow-amber-500/10 ring-1 ring-amber-500/20">
            <div className="flex items-start justify-between gap-3">
              <h4 className="text-sm font-semibold text-popover-foreground">{title}</h4>
              <button
                ref={closeBtnRef}
                onClick={onDismiss}
                disabled={dismissing}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
      </>
    );
  }

  const isHidden = !position;

  const arrowStyle: React.CSSProperties = position
    ? (position.placement === 'top' || position.placement === 'bottom')
      ? { left: position.arrowOffset }
      : { top: position.arrowOffset }
    : {};

  const arrowBorderClass: Record<Placement, string> = {
    top: 'bottom-0 translate-y-full border-x-transparent border-b-transparent border-t-amber-500/60',
    bottom: 'top-0 -translate-y-full border-x-transparent border-t-transparent border-b-amber-500/60',
    left: 'right-0 translate-x-full border-y-transparent border-l-transparent border-r-amber-500/60',
    right: 'left-0 -translate-x-full border-y-transparent border-r-transparent border-l-amber-500/60',
  };

  const arrowFillClass: Record<Placement, string> = {
    top: 'bottom-0 translate-y-[1px] border-x-transparent border-b-transparent border-t-popover',
    bottom: 'top-0 -translate-y-[1px] border-x-transparent border-t-transparent border-b-popover',
    left: 'right-0 translate-x-[1px] border-y-transparent border-l-transparent border-r-popover',
    right: 'left-0 -translate-x-[1px] border-y-transparent border-r-transparent border-l-popover',
  };

  return (
    <>
      <style>{`
        .onboarding-highlight-target {
          box-shadow: 0 0 0 4px rgba(245,158,11,0.5), 0 0 20px rgba(245,158,11,0.3) !important;
          border-radius: 8px !important;
          animation: onboarding-pulse 2s ease-in-out infinite !important;
          cursor: pointer !important;
        }
        @keyframes onboarding-pulse {
          0%, 100% { box-shadow: 0 0 0 4px rgba(245,158,11,0.5), 0 0 20px rgba(245,158,11,0.3); }
          50% { box-shadow: 0 0 0 6px rgba(245,158,11,0.7), 0 0 30px rgba(245,158,11,0.4); }
        }
      `}</style>
      <div className="fixed inset-0 z-[100] bg-black/40 pointer-events-none" />
      <div
        ref={tooltipRef}
        className={`fixed z-[102] max-w-[320px] min-w-[200px] rounded-lg border-2 border-amber-500/60 bg-popover p-3 shadow-xl shadow-amber-500/10 ring-1 ring-amber-500/20 transition-opacity duration-200 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        style={isHidden
          ? { visibility: 'hidden', pointerEvents: 'none' }
          : { top: position!.top, left: position!.left }
        }
        role="dialog"
        aria-label={title}
      >
        {position && (
          <>
            <div
              className={`absolute h-0 w-0 border-[8px] ${arrowBorderClass[position.placement]}`}
              style={arrowStyle}
            />
            <div
              className={`absolute h-0 w-0 border-[8px] ${arrowFillClass[position.placement]}`}
              style={arrowStyle}
            />
          </>
        )}
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-semibold text-popover-foreground">{title}</h4>
          <button
            ref={closeBtnRef}
            onClick={onDismiss}
            disabled={dismissing}
            className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </>
  );
}