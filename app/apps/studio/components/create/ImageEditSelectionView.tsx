'use client';

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, RotateCcw, RotateCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ImageEditSelectionViewProps {
  open: boolean;
  imageUrl: string | null;
  imageAlt?: string | null;
  isSaving?: boolean;
  onClose: () => void;
  onSubmit: (payload: { prompt: string; maskDataUrl: string }) => void;
}

const BRUSH_SIZE = 76;
const MARKER_COLOR = 'rgba(38, 132, 255, 0.28)';

export function ImageEditSelectionView({
  open,
  imageUrl,
  imageAlt,
  isSaving = false,
  onClose,
  onSubmit,
}: ImageEditSelectionViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [hasMarkup, setHasMarkup] = useState(false);

  const resetCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageSize) return;
    canvas.width = imageSize.width;
    canvas.height = imageSize.height;
    const context = canvas.getContext('2d');
    context?.clearRect(0, 0, canvas.width, canvas.height);
    setUndoStack([canvas.toDataURL('image/png')]);
    setRedoStack([]);
    setHasMarkup(false);
  }, [imageSize]);

  useEffect(() => {
    if (!open) {
      setPrompt('');
      setImageSize(null);
      setUndoStack([]);
      setRedoStack([]);
      setHasMarkup(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && imageSize) {
      resetCanvas();
    }
  }, [imageSize, open, resetCanvas]);

  const loadSnapshot = useCallback((snapshot: string) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const image = new Image();
    image.onload = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      setHasMarkup(Array.from(data).some((value, index) => index % 4 === 3 && value > 0));
    };
    image.src = snapshot;
  }, []);

  const getCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const drawPoint = (point: { x: number; y: number }, previous: { x: number; y: number } | null) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = BRUSH_SIZE;
    context.strokeStyle = MARKER_COLOR;
    context.fillStyle = MARKER_COLOR;

    if (previous) {
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(point.x, point.y);
      context.stroke();
    } else {
      context.beginPath();
      context.arc(point.x, point.y, BRUSH_SIZE / 2, 0, Math.PI * 2);
      context.fill();
    }
  };

  const commitSnapshot = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const snapshot = canvas.toDataURL('image/png');
    setUndoStack((current) => {
      if (current[current.length - 1] === snapshot) return current;
      return [...current, snapshot];
    });
    setRedoStack([]);
    setHasMarkup(true);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (isSaving) return;
    const point = getCanvasPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    lastPointRef.current = point;
    drawPoint(point, null);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || isSaving) return;
    const point = getCanvasPoint(event);
    if (!point) return;
    drawPoint(point, lastPointRef.current);
    lastPointRef.current = point;
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastPointRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    commitSnapshot();
  };

  const handleUndo = () => {
    if (undoStack.length <= 1) return;
    const current = undoStack[undoStack.length - 1];
    const previous = undoStack[undoStack.length - 2];
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [current, ...stack]);
    if (previous) loadSnapshot(previous);
  };

  const handleRedo = () => {
    const next = redoStack[0];
    if (!next) return;
    setRedoStack((stack) => stack.slice(1));
    setUndoStack((stack) => [...stack, next]);
    loadSnapshot(next);
  };

  const handleClear = () => {
    resetCanvas();
  };

  const handleSubmit = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasMarkup || !prompt.trim()) return;
    onSubmit({ prompt: prompt.trim(), maskDataUrl: canvas.toDataURL('image/png') });
  };

  if (!open || !imageUrl) return null;

  return (
    <section
      aria-label="Edit selection"
      className="absolute inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-background"
      data-testid="studio-edit-selection"
    >
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-border/70 px-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Button type="button" variant="ghost" size="icon" className="rounded-full" onClick={onClose} disabled={isSaving} aria-label="Close edit selection">
            <X className="h-5 w-5" />
          </Button>
          <h2 className="truncate text-base font-semibold sm:text-lg">Edit selection</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" size="icon" className="rounded-full" onClick={handleUndo} disabled={isSaving || undoStack.length <= 1} aria-label="Undo marker stroke">
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="rounded-full" onClick={handleRedo} disabled={isSaving || redoStack.length === 0} aria-label="Redo marker stroke">
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={handleClear} disabled={isSaving || !hasMarkup}>
            Clear
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto bg-muted/25 px-3 py-4 sm:px-6">
        <div className="relative flex max-h-full w-full max-w-6xl items-center justify-center">
          <div className="relative max-h-[calc(100vh-190px)] max-w-full shadow-2xl">
            <img
              src={imageUrl}
              alt={imageAlt || 'Selected studio output'}
              className="block max-h-[calc(100vh-190px)] max-w-full select-none object-contain"
              draggable={false}
              onLoad={(event) => {
                const target = event.currentTarget;
                setImageSize({ width: target.naturalWidth, height: target.naturalHeight });
              }}
            />
            <canvas
              ref={canvasRef}
              className={cn(
                'absolute inset-0 h-full w-full touch-none cursor-crosshair',
                isSaving && 'cursor-wait opacity-80',
              )}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
              data-testid="studio-edit-canvas"
            />
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-border/70 bg-background/95 px-3 py-3 backdrop-blur sm:px-5">
        <div className="mx-auto flex max-w-4xl items-center gap-2 rounded-[28px] border border-border/80 bg-card px-3 py-2 shadow-xl">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe edits"
            className="min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none"
            rows={1}
            disabled={isSaving}
            data-testid="studio-edit-prompt"
          />
          <Button
            type="button"
            size="icon"
            className="h-11 w-11 shrink-0 rounded-full bg-orange-500 text-white hover:bg-orange-600"
            onClick={handleSubmit}
            disabled={isSaving || !hasMarkup || !prompt.trim()}
            aria-label="Import marked edit"
            data-testid="studio-edit-import"
          >
            <ArrowUp className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </section>
  );
}
