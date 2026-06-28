'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnProgressParameters, PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { AlertCircle, ChevronLeft, ChevronRight, ExternalLink, Loader2, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toMediaUrl } from '@/app/lib/utils/media-url';

interface PdfViewerProps {
  path: string;
  sourceUrl?: string;
}

interface PdfPageCanvasProps {
  containerWidth: number;
  pageNumber: number;
  pdf: PDFDocumentProxy;
  rotation: number;
  scrollRoot: HTMLDivElement | null;
  setPageRef: (pageNumber: number, element: HTMLDivElement | null) => void;
  zoom: number;
}

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;
const MAX_DEVICE_PIXEL_RATIO = 2;
const MAX_PAGE_WIDTH = 1120;
const PAGE_GUTTER = 32;

let pdfJsPromise: Promise<PdfJsModule> | null = null;

function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString();
      return pdfjs;
    });
  }

  return pdfJsPromise;
}

function clampZoom(value: number) {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

function isRenderingCancelled(error: unknown) {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}

function PdfPageCanvas({
  containerWidth,
  pageNumber,
  pdf,
  rotation,
  scrollRoot,
  setPageRef,
  zoom,
}: PdfPageCanvasProps) {
  const t = useTranslations('notebook');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(pageNumber <= 2);
  const [isRendering, setIsRendering] = useState(false);
  const [isRendered, setIsRendered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);

  const setWrapperRef = useCallback((element: HTMLDivElement | null) => {
    wrapperRef.current = element;
    setPageRef(pageNumber, element);
  }, [pageNumber, setPageRef]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !scrollRoot) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      {
        root: scrollRoot,
        rootMargin: '900px 0px',
        threshold: 0,
      }
    );

    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!isNearViewport || containerWidth <= 0) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;

    async function renderPage() {
      const canvas = canvasRef.current;
      if (!canvas) return;

      setIsRendering(true);
      setError(null);

      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1, rotation });
        const availableWidth = Math.max(containerWidth - PAGE_GUTTER, 280);
        const cssWidth = Math.min(availableWidth, MAX_PAGE_WIDTH) * zoom;
        const scale = cssWidth / baseViewport.width;
        const cssViewport = page.getViewport({ scale, rotation });
        const outputScale = Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_DEVICE_PIXEL_RATIO);
        const renderViewport = page.getViewport({ scale: scale * outputScale, rotation });

        canvas.width = Math.floor(renderViewport.width);
        canvas.height = Math.floor(renderViewport.height);
        canvas.style.width = `${Math.floor(cssViewport.width)}px`;
        canvas.style.height = `${Math.floor(cssViewport.height)}px`;

        setPageSize({
          width: Math.floor(cssViewport.width),
          height: Math.floor(cssViewport.height),
        });
        setIsRendered(false);

        renderTask = page.render({
          canvas,
          viewport: renderViewport,
          background: '#ffffff',
        });

        await renderTask.promise;
        if (!cancelled) {
          setIsRendered(true);
        }
      } catch (renderError) {
        if (!cancelled && !isRenderingCancelled(renderError)) {
          console.error('[PdfViewer] Failed to render page:', renderError);
          setError(t('pdfRenderError', { page: pageNumber }));
        }
      } finally {
        if (!cancelled) {
          setIsRendering(false);
        }
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [containerWidth, isNearViewport, pageNumber, pdf, rotation, t, zoom]);

  const fallbackHeight = pageSize?.height ?? 480;
  const fallbackWidth = pageSize?.width ?? Math.min(Math.max(containerWidth - PAGE_GUTTER, 280), MAX_PAGE_WIDTH);

  return (
    <div ref={setWrapperRef} className="mb-4 flex min-w-full justify-center px-2 sm:px-4">
      <div
        className="relative overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-border/70"
        style={{
          width: fallbackWidth,
          minHeight: fallbackHeight,
        }}
      >
        {!isRendered && !error ? (
          <Skeleton className="absolute inset-0 z-0 rounded-none bg-muted" />
        ) : null}

        {isRendering ? (
          <div className="absolute right-3 top-3 z-10 rounded-sm border bg-background/90 p-1 text-muted-foreground shadow-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          </div>
        ) : null}

        {error ? (
          <div className="flex min-h-48 items-center justify-center gap-2 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            aria-label={t('pdfPageLabel', { page: pageNumber })}
            className={`block bg-white transition-opacity duration-150 ${isRendered ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
      </div>
    </div>
  );
}

export function PdfViewer({ path, sourceUrl }: PdfViewerProps) {
  const t = useTranslations('notebook');
  const src = sourceUrl ?? toMediaUrl(path);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const rafRef = useRef<number | null>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [activePage, setActivePage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pages = useMemo(() => Array.from({ length: pageCount }, (_, index) => index + 1), [pageCount]);

  const updateActivePage = useCallback(() => {
    const root = scrollContainerRef.current;
    if (!root || pageRefs.current.size === 0) return;

    const rootRect = root.getBoundingClientRect();
    const targetY = rootRect.top + Math.min(root.clientHeight * 0.35, 260);
    let nextPage: number | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const [pageNumber, element] of pageRefs.current) {
      const rect = element.getBoundingClientRect();
      const pageCenter = rect.top + rect.height * 0.35;
      const distance = Math.abs(pageCenter - targetY);

      if (distance < closestDistance && rect.bottom >= rootRect.top && rect.top <= rootRect.bottom) {
        closestDistance = distance;
        nextPage = pageNumber;
      }
    }

    if (nextPage !== null) {
      setActivePage((currentPage) => (nextPage === currentPage ? currentPage : nextPage));
    }
  }, []);

  const scheduleActivePageUpdate = useCallback(() => {
    if (rafRef.current !== null) return;

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      updateActivePage();
    });
  }, [updateActivePage]);

  const setScrollContainer = useCallback((element: HTMLDivElement | null) => {
    scrollContainerRef.current = element;
    setScrollRoot(element);
  }, []);

  const setPageRef = useCallback((pageNumber: number, element: HTMLDivElement | null) => {
    if (element) {
      pageRefs.current.set(pageNumber, element);
    } else {
      pageRefs.current.delete(pageNumber);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let loadedPdf: PDFDocumentProxy | null = null;

    pageRefs.current.clear();

    async function loadDocument() {
      try {
        const pdfjs = await loadPdfJs();
        if (cancelled) return;

        loadingTask = pdfjs.getDocument({
          url: src,
          withCredentials: true,
        });
        loadingTask.onProgress = ({ loaded, total }: OnProgressParameters) => {
          if (!cancelled && total > 0) {
            setProgress(Math.round((loaded / total) * 100));
          }
        };

        loadedPdf = await loadingTask.promise;
        if (cancelled) return;

        setPdf(loadedPdf);
        setPageCount(loadedPdf.numPages);
        setIsLoading(false);
      } catch (loadError) {
        if (!cancelled) {
          console.error('[PdfViewer] Failed to load PDF:', loadError);
          setError(t('pdfLoadError'));
          setIsLoading(false);
        }
      }
    }

    void loadDocument();

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
      void loadedPdf?.cleanup();
    };
  }, [src, t]);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry?.contentRect.width ?? root.clientWidth);
      setContainerWidth(width);
      scheduleActivePageUpdate();
    });

    resizeObserver.observe(root);
    setContainerWidth(root.clientWidth);

    return () => resizeObserver.disconnect();
  }, [scheduleActivePageUpdate, scrollRoot]);

  useEffect(() => {
    scheduleActivePageUpdate();
  }, [pageCount, rotation, scheduleActivePageUpdate, zoom]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const scrollToPage = useCallback((pageNumber: number) => {
    const nextPage = Math.min(Math.max(pageNumber, 1), pageCount || 1);
    const pageElement = pageRefs.current.get(nextPage);
    if (!pageElement) return;

    pageElement.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setActivePage(nextPage);
  }, [pageCount]);

  const handlePreviousPage = useCallback(() => {
    scrollToPage(activePage - 1);
  }, [activePage, scrollToPage]);

  const handleNextPage = useCallback(() => {
    scrollToPage(activePage + 1);
  }, [activePage, scrollToPage]);

  const zoomOut = useCallback(() => {
    setZoom((value) => clampZoom(value - ZOOM_STEP));
  }, []);

  const zoomIn = useCallback(() => {
    setZoom((value) => clampZoom(value + ZOOM_STEP));
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(1);
  }, []);

  const rotate = useCallback(() => {
    setRotation((value) => (value + 90) % 360);
  }, []);

  const loadingLabel = progress === null
    ? t('pdfLoading')
    : t('pdfLoadingProgress', { progress });

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-background px-2 py-2 sm:flex-nowrap sm:px-3">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handlePreviousPage}
            disabled={!pdf || activePage <= 1}
            aria-label={t('pdfPreviousPage')}
            title={t('pdfPreviousPage')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleNextPage}
            disabled={!pdf || activePage >= pageCount}
            aria-label={t('pdfNextPage')}
            title={t('pdfNextPage')}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="min-w-14 px-1 text-center text-xs text-muted-foreground sm:min-w-16 sm:text-sm">
            {pdf ? t('pdfPageStatus', { page: activePage, total: pageCount }) : '- / -'}
          </span>
        </div>

        <div className="flex min-w-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={zoomOut}
            disabled={!pdf || zoom <= MIN_ZOOM}
            aria-label={t('pdfZoomOut')}
            title={t('pdfZoomOut')}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <button
            type="button"
            onClick={resetZoom}
            disabled={!pdf || zoom === 1}
            className="h-8 min-w-12 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            aria-label={t('pdfResetZoom')}
            title={t('pdfResetZoom')}
          >
            {Math.round(zoom * 100)}%
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={zoomIn}
            disabled={!pdf || zoom >= MAX_ZOOM}
            aria-label={t('pdfZoomIn')}
            title={t('pdfZoomIn')}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={rotate}
            disabled={!pdf}
            aria-label={t('pdfRotate')}
            title={t('pdfRotate')}
          >
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            aria-label={t('pdfOpenExternal')}
            title={t('pdfOpenExternal')}
          >
            <a href={src} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </div>

      <div
        ref={setScrollContainer}
        onScroll={scheduleActivePageUpdate}
        className="min-h-0 flex-1 overflow-auto bg-muted/30 py-4"
      >
        {isLoading ? (
          <div className="flex h-full min-h-72 items-center justify-center p-4">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
              <span className="text-sm">{loadingLabel}</span>
            </div>
          </div>
        ) : error ? (
          <div className="flex h-full min-h-72 items-center justify-center p-4">
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          </div>
        ) : pdf ? (
          <div className="mx-auto flex w-fit min-w-full flex-col items-center">
            {pages.map((pageNumber) => (
              <PdfPageCanvas
                key={`${path}-${pageNumber}`}
                containerWidth={containerWidth}
                pageNumber={pageNumber}
                pdf={pdf}
                rotation={rotation}
                scrollRoot={scrollRoot}
                setPageRef={setPageRef}
                zoom={zoom}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
