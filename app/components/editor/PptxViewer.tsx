'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { init } from 'pptx-preview';

interface PptxViewerProps {
  path: string;
}

export function PptxViewer({ path }: PptxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<ReturnType<typeof init> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [totalSlides, setTotalSlides] = useState(0);
  const isMobile = useIsMobile();

  useEffect(() => {
    const loadPptx = async () => {
      try {
        // Fetch PPTX file
        const response = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`, {
          credentials: 'include'
        });
        
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();

        if (containerRef.current) {
          // Calculate responsive dimensions
          const containerWidth = containerRef.current.clientWidth - 32; // padding
          const isMobileDevice = window.innerWidth < 768;
          const baseWidth = isMobileDevice ? Math.min(containerWidth, 640) : 960;
          const aspectRatio = 16 / 9;
          const height = Math.floor(baseWidth / aspectRatio);

          // Initialize pptx-preview
          const previewer = init(containerRef.current, {
            width: baseWidth,
            height: height,
            mode: 'slide',
          });

          previewerRef.current = previewer;

          // Load the presentation
          await previewer.preview(arrayBuffer);

          // Count slides by querying the DOM
          const slides = containerRef.current.querySelectorAll('.pptx-slide');
          setTotalSlides(slides.length);
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
      // Cleanup
      if (previewerRef.current) {
        previewerRef.current.destroy();
        previewerRef.current = null;
      }
    };
  }, [path, isMobile]);

  const goToSlide = (index: number) => {
    if (containerRef.current && index >= 0 && index < totalSlides) {
      const slides = containerRef.current.querySelectorAll('.pptx-slide');
      if (slides[index]) {
        slides[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
        setCurrentSlide(index);
      }
    }
  };

  const nextSlide = () => {
    if (currentSlide < totalSlides - 1) {
      goToSlide(currentSlide + 1);
    }
  };

  const prevSlide = () => {
    if (currentSlide > 0) {
      goToSlide(currentSlide - 1);
    }
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
            {currentSlide + 1}/{totalSlides}
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
