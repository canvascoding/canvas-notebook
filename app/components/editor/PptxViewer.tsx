'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { init } from 'pptx-preview';

interface PptxViewerProps {
  path: string;
}

type Previewer = ReturnType<typeof init> & {
  renderNextSlide?: () => void;
  renderPreSlide?: () => void;
  currentIndex?: number;
  pptx?: { slides?: unknown[] };
};

export function PptxViewer({ path }: PptxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<Previewer | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [totalSlides, setTotalSlides] = useState(0);

  useEffect(() => {
    const loadPptx = async () => {
      try {
        const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`, {
          credentials: 'include'
        });

        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();

        if (containerRef.current) {
          // destroy() does not clear the DOM, so we do it manually to prevent
          // double renders (React 18 StrictMode double-invokes effects)
          containerRef.current.innerHTML = '';

          const containerWidth = containerRef.current.clientWidth - 32;
          const isMobileDevice = window.innerWidth < 768;
          const baseWidth = isMobileDevice ? Math.min(containerWidth, 640) : 960;
          const height = Math.floor(baseWidth / (16 / 9));

          const previewer = init(containerRef.current, {
            width: baseWidth,
            height: height,
            mode: 'slide',
          }) as Previewer;

          previewerRef.current = previewer;
          await previewer.preview(arrayBuffer);

          // Hide the library's built-in nav buttons — we render our own
          containerRef.current.querySelectorAll<HTMLElement>(
            '.pptx-preview-wrapper-next, .pptx-preview-wrapper-pagination'
          ).forEach(el => { el.style.display = 'none'; });

          const count = previewer.pptx?.slides?.length ?? 0;
          setTotalSlides(count);
          setCurrentSlide(0);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('[PptxViewer] Error loading PPTX:', err);
        setError(err instanceof Error ? err.message : 'Failed to load presentation');
        setIsLoading(false);
      }
    };

    loadPptx();

    return () => {
      if (previewerRef.current) {
        previewerRef.current.destroy();
        previewerRef.current = null;
      }
    };
  }, [path]);

  const nextSlide = () => {
    const p = previewerRef.current;
    if (!p || currentSlide >= totalSlides - 1) return;
    p.renderNextSlide?.();
    setCurrentSlide(idx => idx + 1);
  };

  const prevSlide = () => {
    const p = previewerRef.current;
    if (!p || currentSlide <= 0) return;
    p.renderPreSlide?.();
    setCurrentSlide(idx => idx - 1);
  };

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-destructive/10 p-4">
        <div className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {isLoading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">Loading presentation...</span>
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        className="flex-1 overflow-auto p-2 sm:p-4"
        style={{ minHeight: '300px' }}
      />

      {!isLoading && totalSlides > 0 && (
        <div className="flex items-center justify-center gap-2 sm:gap-4 p-2 sm:p-4 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            onClick={prevSlide}
            disabled={currentSlide === 0}
            className="h-8 w-8 p-0 sm:h-9 sm:w-auto sm:px-3"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <span className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
            {currentSlide + 1} / {totalSlides}
          </span>

          <Button
            variant="outline"
            size="sm"
            onClick={nextSlide}
            disabled={currentSlide >= totalSlides - 1}
            className="h-8 w-8 p-0 sm:h-9 sm:w-auto sm:px-3"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

export default PptxViewer;
