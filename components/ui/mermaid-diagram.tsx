'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import mermaid from 'mermaid';
import { ZoomIn, ZoomOut, RotateCcw, Download, Maximize2, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose',
});

let mermaidRenderCounter = 0;

interface MermaidDiagramProps {
  code: string;
  interactive?: boolean;
}

function cleanupMermaidDom(id: string) {
  const el = document.getElementById(id);
  if (el) el.remove();
  const d1 = document.getElementById('d' + id);
  if (d1) d1.remove();
}

async function renderMermaid(code: string, prefix: string): Promise<{ svg: string; id: string }> {
  const id = `${prefix}-${++mermaidRenderCounter}`;
  const { svg } = await mermaid.render(id, code.trim());
  return { svg, id };
}

export function MermaidDiagram({ code, interactive = true }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const svgIdRef = useRef<string | null>(null);
  const [isDark, setIsDark] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [fullscreenSvg, setFullscreenSvg] = useState<string | null>(null);
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOffsetStart = useRef({ x: 0, y: 0 });
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => {
      const root = document.documentElement;
      const dark = root.classList.contains('dark') || mq.matches;
      setIsDark(dark);
    };
    updateTheme();
    mq.addEventListener('change', updateTheme);
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      mq.removeEventListener('change', updateTheme);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const renderDiagram = async () => {
      try {
        if (svgIdRef.current) cleanupMermaidDom(svgIdRef.current);
        const result = await renderMermaid(code, 'm');
        if (!cancelled) {
          setSvg(result.svg);
          svgIdRef.current = result.id;
          setError(null);
        } else {
          cleanupMermaidDom(result.id);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvg(null);
        }
      }
    };
    renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [code, isDark]);

  useEffect(() => {
    const id = svgIdRef.current;
    return () => {
      if (id) cleanupMermaidDom(id);
      if (fullscreenId) cleanupMermaidDom(fullscreenId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDialog = useCallback(async () => {
    if (!interactive) return;
    try {
      if (fullscreenId) cleanupMermaidDom(fullscreenId);
      const result = await renderMermaid(code, 'mf');
      setFullscreenSvg(result.svg);
      setFullscreenId(result.id);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setDialogOpen(true);
    } catch {
      setFullscreenSvg(null);
    }
  }, [code, interactive, fullscreenId]);

  const wheelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wheelRef.current;
    if (!el || !dialogOpen) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const isZoom = e.ctrlKey || e.metaKey;
      if (isZoom) {
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom((z) => Math.min(5, Math.max(0.25, z * delta)));
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [dialogOpen]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY };
    panOffsetStart.current = { ...pan };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    setPan({
      x: panOffsetStart.current.x + (e.clientX - panStart.current.x),
      y: panOffsetStart.current.y + (e.clientY - panStart.current.y),
    });
  }, [isPanning]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const handleDoubleClick = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      lastTouchDist.current = Math.sqrt(dx * dx + dy * dy);
      lastTouchCenter.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    } else if (e.touches.length === 1) {
      setIsPanning(true);
      panStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      panOffsetStart.current = { ...pan };
    }
  }, [pan]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && lastTouchDist.current !== null) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const scale = dist / lastTouchDist.current;
      setZoom((z) => Math.min(5, Math.max(0.25, z * scale)));
      lastTouchDist.current = dist;
    } else if (e.touches.length === 1 && isPanning) {
      setPan({
        x: panOffsetStart.current.x + (e.touches[0].clientX - panStart.current.x),
        y: panOffsetStart.current.y + (e.touches[0].clientY - panStart.current.y),
      });
    }
  }, [isPanning]);

  const handleTouchEnd = useCallback(() => {
    setIsPanning(false);
    lastTouchDist.current = null;
    lastTouchCenter.current = null;
  }, []);

  const handleDownload = useCallback(() => {
    if (!fullscreenSvg) return;
    const blob = new Blob([fullscreenSvg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mermaid-diagram.svg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [fullscreenSvg]);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(5, z * 1.25)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(0.25, z / 1.25)), []);
  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  if (error) {
    return (
      <div className="mermaid-error my-3 rounded-md border border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/30">
        <p className="mb-1 text-xs font-semibold text-red-600 dark:text-red-400">Mermaid Syntax Error</p>
        <pre className="overflow-x-auto text-xs text-red-700 dark:text-red-300">{code}</pre>
        <p className="mt-1 text-xs text-red-500 dark:text-red-400">{error}</p>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-3 flex min-h-12 items-center justify-center">
        <span className="text-xs text-muted-foreground">Rendering diagram…</span>
      </div>
    );
  }

  return (
    <>
      <div
        className={`mermaid-diagram my-3 relative flex justify-center overflow-x-auto pb-6 [&_svg]:max-w-full [&_svg]:h-auto ${
          interactive ? 'group cursor-pointer' : ''
        }`}
        onClick={interactive ? openDialog : undefined}
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') openDialog(); } : undefined}
      >
        <div ref={containerRef} dangerouslySetInnerHTML={{ __html: svg }} />
        {interactive && (
          <div className="pointer-events-none absolute bottom-1 right-1 flex items-center gap-1 rounded bg-black/60 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Maximize2 className="size-3.5 text-white" />
            <span className="text-[10px] text-white font-medium">Click to expand</span>
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent layout="viewport" showCloseButton={false} className="p-0 gap-0">
          <DialogTitle className="sr-only">Mermaid Diagram Fullscreen</DialogTitle>
          <DialogDescription className="sr-only">Interactive mermaid diagram view with zoom and pan controls</DialogDescription>

          <div className="flex items-center justify-between border-b px-3 py-2 bg-muted/50">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">{Math.round(zoom * 100)}%</span>
              <span className="text-xs text-muted-foreground/60 hidden sm:inline">(Ctrl/Cmd + Scroll to zoom)</span>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={zoomOut} className="rounded p-1.5 hover:bg-muted transition-colors" title="Zoom Out">
                <ZoomOut className="size-4" />
              </button>
              <button onClick={zoomIn} className="rounded p-1.5 hover:bg-muted transition-colors" title="Zoom In">
                <ZoomIn className="size-4" />
              </button>
              <button onClick={resetView} className="rounded p-1.5 hover:bg-muted transition-colors" title="Reset View">
                <RotateCcw className="size-4" />
              </button>
              <button onClick={handleDownload} className="rounded p-1.5 hover:bg-muted transition-colors" title="Download SVG">
                <Download className="size-4" />
              </button>
              <DialogClose className="rounded p-1.5 hover:bg-muted transition-colors" title="Close">
                <X className="size-4" />
              </DialogClose>
            </div>
          </div>

          <div
            ref={wheelRef}
            className="flex-1 min-h-0 overflow-auto"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onDoubleClick={handleDoubleClick}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
          >
            <div
              className="min-h-full min-w-full flex items-center justify-center p-8"
              style={{ transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`, transformOrigin: 'center center', transition: isPanning ? 'none' : 'transform 0.15s ease' }}
            >
              {fullscreenSvg && (
                <div dangerouslySetInnerHTML={{ __html: fullscreenSvg }} className="[&_svg]:max-w-none" />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}