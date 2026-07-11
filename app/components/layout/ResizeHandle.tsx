'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { cn } from '@/lib/utils';

export type ResizeOrientation = 'horizontal' | 'vertical';

type ResizeHandleProps = Omit<HTMLAttributes<HTMLDivElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp'> & {
  orientation: ResizeOrientation;
  label: string;
  min: number;
  max: number;
  value: number;
  controls?: string;
  resizing?: boolean;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onLostPointerCapture?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
};

export const ResizeHandle = forwardRef<HTMLDivElement, ResizeHandleProps>(function ResizeHandle(
  {
    orientation,
    label,
    min,
    max,
    value,
    controls,
    resizing = false,
    className,
    ...props
  },
  ref,
) {
  const isVertical = orientation === 'vertical';

  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-controls={controls}
      aria-orientation={orientation}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      data-resizing={resizing ? 'true' : 'false'}
      className={cn(
        'group/resize-handle relative z-[90] flex shrink-0 touch-none select-none items-center justify-center outline-none',
        'before:absolute before:content-[\'\']',
        isVertical
          ? 'h-full w-px cursor-col-resize before:inset-y-0 before:left-1/2 before:w-3 before:-translate-x-1/2'
          : 'h-px w-full cursor-row-resize before:inset-x-0 before:top-1/2 before:h-3 before:-translate-y-1/2',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'resize-handle-line pointer-events-none absolute bg-border',
          'transition-[background-color,box-shadow,opacity] duration-150 ease-out motion-reduce:transition-none',
          'group-hover/resize-handle:bg-primary/55 group-focus-visible/resize-handle:bg-primary/75',
          'group-focus-visible/resize-handle:shadow-[0_0_0_3px_hsl(var(--primary)/0.16)]',
          'group-data-[resizing=true]/resize-handle:bg-primary',
          'group-data-[resizing=true]/resize-handle:shadow-[0_0_0_3px_hsl(var(--primary)/0.2)]',
          isVertical
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2',
        )}
      />
    </div>
  );
});

type Bound = number | (() => number);

type UsePanelResizeOptions = {
  orientation: ResizeOrientation;
  value: number;
  min: Bound;
  max: Bound;
  direction?: 1 | -1;
  step?: number;
  largeStep?: number;
  onResize: (value: number) => void;
  onResizeEnd: (value: number) => void;
  onResizeStart?: () => void;
};

type DragState = {
  pointerId: number;
  startCoordinate: number;
  startValue: number;
};

function resolveBound(bound: Bound) {
  return typeof bound === 'function' ? bound() : bound;
}

export function clampPanelResizeValue(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(minimum, maximum), Math.max(minimum, value));
}

export function getKeyboardPanelResizeValue({
  key,
  orientation,
  direction = 1,
  value,
  minimum,
  maximum,
  step = 10,
  largeStep = 40,
  useLargeStep = false,
}: {
  key: string;
  orientation: ResizeOrientation;
  direction?: 1 | -1;
  value: number;
  minimum: number;
  maximum: number;
  step?: number;
  largeStep?: number;
  useLargeStep?: boolean;
}) {
  if (key === 'Home') return minimum;
  if (key === 'End') return Math.max(minimum, maximum);

  const resolvedStep = useLargeStep ? largeStep : step;
  let coordinateDelta: number | null = null;

  if (orientation === 'vertical' && key === 'ArrowLeft') {
    coordinateDelta = -resolvedStep;
  } else if (orientation === 'vertical' && key === 'ArrowRight') {
    coordinateDelta = resolvedStep;
  } else if (orientation === 'horizontal' && key === 'ArrowUp') {
    coordinateDelta = -resolvedStep;
  } else if (orientation === 'horizontal' && key === 'ArrowDown') {
    coordinateDelta = resolvedStep;
  }

  if (coordinateDelta === null) return null;
  return clampPanelResizeValue(value + (coordinateDelta * direction), minimum, maximum);
}

export function usePanelResize(options: UsePanelResizeOptions) {
  const optionsRef = useRef(options);
  const currentValueRef = useRef(options.value);
  const dragRef = useRef<DragState | null>(null);
  const pendingValueRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const keyboardFrameRef = useRef<number | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const previousBodyStylesRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    if (!dragRef.current) {
      currentValueRef.current = options.value;
    }
  }, [options.value]);

  const getBounds = useCallback(() => {
    const minimum = resolveBound(optionsRef.current.min);
    const maximum = Math.max(minimum, resolveBound(optionsRef.current.max));
    return { minimum, maximum };
  }, []);

  const clampValue = useCallback((value: number) => {
    const { minimum, maximum } = getBounds();
    return clampPanelResizeValue(value, minimum, maximum);
  }, [getBounds]);

  const applyValue = useCallback((value: number) => {
    const nextValue = clampValue(value);
    currentValueRef.current = nextValue;
    optionsRef.current.onResize(nextValue);
    handleRef.current?.setAttribute('aria-valuenow', String(Math.round(nextValue)));
    return nextValue;
  }, [clampValue]);

  const flushPendingValue = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const pendingValue = pendingValueRef.current;
    pendingValueRef.current = null;
    return pendingValue === null ? currentValueRef.current : applyValue(pendingValue);
  }, [applyValue]);

  const scheduleValue = useCallback((value: number) => {
    pendingValueRef.current = clampValue(value);
    if (animationFrameRef.current !== null) return;

    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      const pendingValue = pendingValueRef.current;
      pendingValueRef.current = null;
      if (pendingValue !== null) {
        applyValue(pendingValue);
      }
    });
  }, [applyValue, clampValue]);

  const restoreDocumentInteraction = useCallback(() => {
    const previousStyles = previousBodyStylesRef.current;
    if (previousStyles) {
      document.body.style.cursor = previousStyles.cursor;
      document.body.style.userSelect = previousStyles.userSelect;
      previousBodyStylesRef.current = null;
    }
  }, []);

  const finishResize = useCallback((pointerId?: number) => {
    const dragState = dragRef.current;
    if (!dragState || (pointerId !== undefined && dragState.pointerId !== pointerId)) return;

    const finalValue = flushPendingValue();
    dragRef.current = null;
    handleRef.current = null;
    restoreDocumentInteraction();
    setIsResizing(false);
    optionsRef.current.onResizeEnd(finalValue);
  }, [flushPendingValue, restoreDocumentInteraction]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    event.preventDefault();
    const orientation = optionsRef.current.orientation;
    const startValue = clampValue(currentValueRef.current);
    const handle = event.currentTarget;

    handle.setPointerCapture(event.pointerId);
    handleRef.current = handle;
    dragRef.current = {
      pointerId: event.pointerId,
      startCoordinate: orientation === 'vertical' ? event.clientX : event.clientY,
      startValue,
    };
    previousBodyStylesRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    setIsResizing(true);
    optionsRef.current.onResizeStart?.();
  }, [clampValue]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    event.preventDefault();
    const { orientation, direction = 1 } = optionsRef.current;
    const coordinate = orientation === 'vertical' ? event.clientX : event.clientY;
    scheduleValue(dragState.startValue + ((coordinate - dragState.startCoordinate) * direction));
  }, [scheduleValue]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishResize(event.pointerId);
  }, [finishResize]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const onLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const commitKeyboardValue = useCallback((value: number) => {
    const nextValue = applyValue(value);
    optionsRef.current.onResizeEnd(nextValue);
  }, [applyValue]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const {
      orientation,
      direction = 1,
      step = 10,
      largeStep = 40,
    } = optionsRef.current;
    const { minimum, maximum } = getBounds();
    const nextValue = getKeyboardPanelResizeValue({
      key: event.key,
      orientation,
      direction,
      value: currentValueRef.current,
      minimum,
      maximum,
      step,
      largeStep,
      useLargeStep: event.shiftKey,
    });

    if (nextValue === null) return;
    event.preventDefault();
    if (keyboardFrameRef.current !== null) {
      cancelAnimationFrame(keyboardFrameRef.current);
    }
    setIsResizing(true);
    commitKeyboardValue(nextValue);
    keyboardFrameRef.current = requestAnimationFrame(() => {
      keyboardFrameRef.current = null;
      setIsResizing(false);
    });
  }, [commitKeyboardValue, getBounds]);

  useEffect(() => {
    const handleWindowBlur = () => finishResize();
    window.addEventListener('blur', handleWindowBlur);
    return () => window.removeEventListener('blur', handleWindowBlur);
  }, [finishResize]);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    if (keyboardFrameRef.current !== null) {
      cancelAnimationFrame(keyboardFrameRef.current);
    }
    restoreDocumentInteraction();
  }, [restoreDocumentInteraction]);

  return {
    isResizing,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onKeyDown,
    },
  };
}
