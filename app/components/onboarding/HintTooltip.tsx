'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

interface HintTooltipProps {
  title: string;
  description: string;
  targetId: string;
  mobileTargetId?: string;
  onDismiss: () => void;
  dismissing?: boolean;
}

type Placement = 'top' | 'bottom' | 'left' | 'right';

interface Position {
  top: number;
  left: number;
  placement: Placement;
}

const MOBILE_BREAKPOINT = 768;
const TOOLTIP_OFFSET = 10;
const ARROW_SIZE = 8;

function computePosition(targetEl: HTMLElement, tooltipEl: HTMLElement): Position {
  const targetRect = targetEl.getBoundingClientRect();
  const tooltipRect = tooltipEl.getBoundingClientRect();
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  const spaceAbove = targetRect.top;
  const spaceBelow = viewportH - targetRect.bottom;
  const spaceLeft = targetRect.left;
  const spaceRight = viewportW - targetRect.right;

  let placement: Placement;
  if (spaceAbove > tooltipRect.height + TOOLTIP_OFFSET + ARROW_SIZE && spaceAbove > spaceBelow) {
    placement = 'top';
  } else if (spaceBelow > tooltipRect.height + TOOLTIP_OFFSET + ARROW_SIZE) {
    placement = 'bottom';
  } else if (spaceRight > tooltipRect.width + TOOLTIP_OFFSET + ARROW_SIZE) {
    placement = 'right';
  } else if (spaceLeft > tooltipRect.width + TOOLTIP_OFFSET + ARROW_SIZE) {
    placement = 'left';
  } else {
    placement = 'bottom';
  }

  let top: number;
  let left: number;

  switch (placement) {
    case 'top':
      top = targetRect.top + scrollY - tooltipRect.height - TOOLTIP_OFFSET - ARROW_SIZE;
      left = targetRect.left + scrollX + targetRect.width / 2 - tooltipRect.width / 2;
      break;
    case 'bottom':
      top = targetRect.bottom + scrollY + TOOLTIP_OFFSET + ARROW_SIZE;
      left = targetRect.left + scrollX + targetRect.width / 2 - tooltipRect.width / 2;
      break;
    case 'left':
      top = targetRect.top + scrollY + targetRect.height / 2 - tooltipRect.height / 2;
      left = targetRect.left + scrollX - tooltipRect.width - TOOLTIP_OFFSET - ARROW_SIZE;
      break;
    case 'right':
      top = targetRect.top + scrollY + targetRect.height / 2 - tooltipRect.height / 2;
      left = targetRect.right + scrollX + TOOLTIP_OFFSET + ARROW_SIZE;
      break;
  }

  left = Math.max(8, Math.min(left, viewportW - tooltipRect.width - 8));

  return { top, left, placement };
}

export function HintTooltip({
  title,
  description,
  targetId,
  mobileTargetId,
  onDismiss,
  dismissing,
}: HintTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [visible, setVisible] = useState(false);
  const [isMobileView, setIsMobileView] = useState(false);

  const effectiveTargetId = (isMobileView && mobileTargetId) ? mobileTargetId : targetId;

  useEffect(() => {
    const handleResize = () => {
      setIsMobileView(window.innerWidth < MOBILE_BREAKPOINT);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkTarget = () => {
      if (cancelled) return;
      const targetEl = document.getElementById(effectiveTargetId);
      const tooltipEl = tooltipRef.current;
      if (!targetEl || !tooltipEl) {
        const retryTimer = setTimeout(checkTarget, 200);
        return () => clearTimeout(retryTimer);
      }

      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

      requestAnimationFrame(() => {
        if (cancelled) return;
        const pos = computePosition(targetEl, tooltipEl);
        setPosition(pos);
        setVisible(true);
      });
    };

    const timer = setTimeout(checkTarget, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [effectiveTargetId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDismiss]);

  useEffect(() => {
    if (visible && closeBtnRef.current) {
      closeBtnRef.current.focus();
    }
  }, [visible]);

  if (isMobileView) {
    return (
      <div
        className={`fixed inset-x-0 bottom-0 z-[100] transition-transform duration-300 ease-out ${
          visible ? 'translate-y-0' : 'translate-y-full'
        }`}
        role="dialog"
        aria-label={title}
      >
        <div
          className="fixed inset-0 z-[99] bg-black/20"
          onClick={onDismiss}
        />
        <div className="relative z-[100] mx-4 mb-4 rounded-xl border border-border bg-popover p-4 shadow-lg">
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
    );
  }

  if (!position) return null;

  const arrowClasses: Record<Placement, string> = {
    top: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-full border-x-transparent border-b-transparent border-t-popover',
    bottom: 'top-0 left-1/2 -translate-x-1/2 -translate-y-full border-x-transparent border-t-transparent border-b-popover',
    left: 'right-0 top-1/2 -translate-y-1/2 translate-x-full border-y-transparent border-l-transparent border-r-popover',
    right: 'left-0 top-1/2 -translate-y-1/2 -translate-x-full border-y-transparent border-r-transparent border-l-popover',
  };

  return (
    <div
      ref={tooltipRef}
      className={`fixed z-[100] max-w-[320px] min-w-[200px] rounded-lg border border-border bg-popover p-3 shadow-lg transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      style={{
        top: position.top,
        left: position.left,
      }}
      role="dialog"
      aria-label={title}
    >
      <div
        className={`absolute h-0 w-0 border-[8px] ${arrowClasses[position.placement]}`}
      />
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
  );
}