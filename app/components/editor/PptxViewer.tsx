'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Chart from 'chart.js/auto';
import JSZip from 'jszip';
import { PPTXViewer } from 'pptxviewjs';

interface PptxViewerProps {
  path: string;
  sourceUrl?: string;
}

const FALLBACK_SLIDE_RATIO = 16 / 9;

function exposePptxPeerDependencies() {
  const globalScope = globalThis as typeof globalThis & {
    Chart?: typeof Chart;
    JSZip?: typeof JSZip;
  };

  globalScope.Chart ??= Chart;
  globalScope.JSZip ??= JSZip;
}

function fitCanvasToContainer(canvas: HTMLCanvasElement, container: HTMLDivElement) {
  const containerWidth = Math.max(container.clientWidth - 32, 280);
  const maxWidth = window.innerWidth < 768 ? 640 : 960;
  const cssWidth = Math.min(containerWidth, maxWidth);
  const cssHeight = Math.floor(cssWidth / FALLBACK_SLIDE_RATIO);
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
}

export function PptxViewer({ path, sourceUrl }: PptxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<PPTXViewer | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRendering, setIsRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [totalSlides, setTotalSlides] = useState(0);

  const renderSlide = useCallback(async (slideIndex: number) => {
    const viewer = viewerRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!viewer || !canvas || !container) return;

    fitCanvasToContainer(canvas, container);
    setIsRendering(true);
    try {
      await viewer.renderSlide(slideIndex, canvas, { quality: 'high' });
      setCurrentSlide(slideIndex);
    } finally {
      setIsRendering(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    const loadPptx = async () => {
      try {
        setIsLoading(true);
        setError(null);
        exposePptxPeerDependencies();

        const response = await fetch(sourceUrl ?? `/api/files/download?path=${encodeURIComponent(path)}`, {
          credentials: 'include'
        });

        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();

        if (cancelled || !canvasRef.current || !containerRef.current) return;

        const viewer = new PPTXViewer({
          canvas: canvasRef.current,
          backgroundColor: '#ffffff',
          enableThumbnails: false,
          slideSizeMode: 'fit',
          autoExposeGlobals: true,
        });

        viewerRef.current = viewer;
        await viewer.loadFile(arrayBuffer);
        if (cancelled) return;

        const count = viewer.getSlideCount();
        setTotalSlides(count);
        setCurrentSlide(0);

        if (count > 0) {
          await renderSlide(0);
        }

        if (!cancelled) {
          setIsLoading(false);
        }

        resizeObserver = new ResizeObserver(() => {
          void renderSlide(viewer.getCurrentSlideIndex());
        });
        resizeObserver.observe(containerRef.current);
      } catch (err) {
        console.error('[PptxViewer] Error loading PPTX:', err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load presentation');
          setIsLoading(false);
        }
      }
    };

    loadPptx();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, [path, renderSlide, sourceUrl]);

  const nextSlide = async () => {
    if (currentSlide >= totalSlides - 1 || isRendering) return;
    await renderSlide(currentSlide + 1);
  };

  const prevSlide = async () => {
    if (currentSlide <= 0 || isRendering) return;
    await renderSlide(currentSlide - 1);
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
        className="flex flex-1 items-center justify-center overflow-auto p-2 sm:p-4"
        style={{ minHeight: '300px' }}
      >
        <canvas
          ref={canvasRef}
          className="block max-w-full bg-white shadow-sm"
          aria-label="PowerPoint slide preview"
        />
      </div>

      {!isLoading && totalSlides > 0 && (
        <div className="flex items-center justify-center gap-2 sm:gap-4 p-2 sm:p-4 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            onClick={prevSlide}
            disabled={currentSlide === 0 || isRendering}
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
            disabled={currentSlide >= totalSlides - 1 || isRendering}
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
