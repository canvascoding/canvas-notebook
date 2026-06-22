'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export type ReferenceType = 'product' | 'persona' | 'style' | 'preset' | 'file';

interface ReferenceHoverCardProps {
  children: React.ReactNode;
  name: string;
  type: ReferenceType;
  thumbnailPath?: string;
  previewImagePaths?: string[];
  fallbackIcon: React.ReactNode;
  bgColor: string;
  onRemove: () => void;
}

const TYPE_LABELS: Record<ReferenceType, string> = {
  product: 'Product',
  persona: 'Persona',
  style: 'Style',
  preset: 'Preset',
  file: 'File',
};

const TYPE_BADGE_COLORS: Record<ReferenceType, string> = {
  product: 'bg-amber-100 text-amber-700',
  persona: 'bg-sky-100 text-sky-700',
  style: 'bg-emerald-100 text-emerald-700',
  preset: 'bg-violet-100 text-violet-700',
  file: 'bg-rose-100 text-rose-700',
};

const MULTI_IMAGE_REFERENCE_TYPES = new Set<ReferenceType>(['product', 'persona', 'style']);

function getUniquePreviewPaths(paths: Array<string | undefined>) {
  const seen = new Set<string>();
  return paths.filter((path): path is string => {
    if (!path || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

function PreviewImageSkeleton() {
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-hidden bg-muted/90" aria-hidden="true">
      <div className="absolute inset-0 animate-pulse bg-[radial-gradient(circle_at_25%_20%,hsl(var(--background)/0.75),transparent_30%),linear-gradient(135deg,hsl(var(--muted)),hsl(var(--accent)),hsl(var(--muted)))]" />
      <div className="relative flex w-4/5 flex-col items-center gap-3">
        <Skeleton className="h-28 w-full rounded-lg bg-background/70" />
        <div className="flex w-full gap-2">
          <Skeleton className="h-2.5 flex-1 rounded-full bg-background/60" />
          <Skeleton className="h-2.5 w-14 rounded-full bg-background/60" />
        </div>
      </div>
    </div>
  );
}

function PreviewImage({
  previewUrl,
  name,
  fallbackIcon,
}: {
  previewUrl: string;
  name: string;
  fallbackIcon: React.ReactNode;
}) {
  const [imageStatus, setImageStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const image = imageRef.current;
    if (!image?.complete) return;

    setImageStatus(image.naturalWidth > 0 ? 'loaded' : 'error');
  }, [previewUrl]);

  if (imageStatus === 'error') {
    return (
      <div className="relative z-[1] flex aspect-square w-full max-w-[280px] items-center justify-center">
        {fallbackIcon}
      </div>
    );
  }

  return (
    <>
      {imageStatus === 'loading' ? <PreviewImageSkeleton /> : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imageRef}
        src={previewUrl}
        alt={name}
        className={cn(
          'relative z-[1] block h-auto max-h-[min(52dvh,360px)] w-auto max-w-full object-contain transition-opacity duration-300',
          imageStatus === 'loaded' ? 'opacity-100' : 'opacity-0',
        )}
        loading="eager"
        decoding="async"
        onLoad={() => setImageStatus('loaded')}
        onError={() => setImageStatus('error')}
      />
    </>
  );
}

function PreviewContent({
  name,
  type,
  thumbnailPath,
  previewImagePaths,
  fallbackIcon,
  onRemove,
  showCloseButton,
}: {
  name: string;
  type: ReferenceType;
  thumbnailPath?: string;
  previewImagePaths?: string[];
  fallbackIcon: React.ReactNode;
  onRemove: () => void;
  showCloseButton: boolean;
}) {
  const canShowMultipleImages = MULTI_IMAGE_REFERENCE_TYPES.has(type);
  const imagePaths = getUniquePreviewPaths([
    ...(canShowMultipleImages ? previewImagePaths ?? [] : []),
    thumbnailPath,
  ]);
  const [imageIndex, setImageIndex] = useState(0);
  const safeImageIndex = imagePaths.length > 0 ? imageIndex % imagePaths.length : 0;
  const currentImagePath = imagePaths[safeImageIndex];
  const previewUrl = currentImagePath ? toPreviewUrl(currentImagePath, 320, { preset: 'mini' }) : undefined;
  const hasMultipleImages = canShowMultipleImages && imagePaths.length > 1;
  const nextPreviewPath = hasMultipleImages ? imagePaths[(safeImageIndex + 1) % imagePaths.length] : undefined;

  const handleNavigateImage = (direction: -1 | 1) => {
    setImageIndex((current) => {
      if (imagePaths.length <= 1) return current;
      return (current + direction + imagePaths.length) % imagePaths.length;
    });
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <div className={cn(
        'relative mx-auto flex w-full max-w-[320px] items-center justify-center overflow-hidden rounded-md bg-muted',
        previewUrl && 'min-h-56',
      )}>
        {previewUrl ? (
          <PreviewImage key={previewUrl} previewUrl={previewUrl} name={name} fallbackIcon={fallbackIcon} />
        ) : (
          <div className="flex aspect-square w-full max-w-[280px] items-center justify-center">
            {fallbackIcon}
          </div>
        )}
        {nextPreviewPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={toPreviewUrl(nextPreviewPath, 320, { preset: 'mini' })}
            alt=""
            aria-hidden="true"
            className="sr-only"
            loading="eager"
          />
        ) : null}
        {hasMultipleImages ? (
          <>
            <button
              type="button"
              aria-label="Previous preview image"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleNavigateImage(-1);
              }}
              className="absolute left-2 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/60 bg-black/45 text-white shadow-sm backdrop-blur-sm transition hover:bg-black/65"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Next preview image"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleNavigateImage(1);
              }}
              className="absolute right-2 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/60 bg-black/45 text-white shadow-sm backdrop-blur-sm transition hover:bg-black/65"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div className="absolute bottom-2 right-2 z-10 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm backdrop-blur-sm">
              {safeImageIndex + 1}/{imagePaths.length}
            </div>
          </>
        ) : null}
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className={cn(
            'absolute top-2 right-2 z-20 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-destructive/10 text-destructive shadow-sm backdrop-blur-sm transition-colors hover:bg-destructive/20',
          )}
          title="Remove reference"
        >
          <Trash2 className="h-4 w-4 pointer-events-none" />
        </button>
      </div>
      <div className="flex items-center gap-2 px-1 overflow-hidden">
        <span className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', TYPE_BADGE_COLORS[type])}>
          {TYPE_LABELS[type]}
        </span>
        <span className="min-w-0 truncate text-sm font-medium">{name}</span>
      </div>
      {showCloseButton && (
        <DialogClose asChild>
          <Button variant="outline" size="sm" className="mt-1 w-full">
            Close
          </Button>
        </DialogClose>
      )}
    </div>
  );
}

export function ReferenceHoverCard({
  children,
  name,
  type,
  thumbnailPath,
  previewImagePaths,
  fallbackIcon,
  bgColor,
  onRemove,
}: ReferenceHoverCardProps) {
  const [mobileDialogOpen, setMobileDialogOpen] = useState(false);

  const handleRemove = useCallback(() => {
    setMobileDialogOpen(false);
    onRemove();
  }, [onRemove]);

  const scaledFallbackIcon = (
    <div className={cn('flex h-full w-full items-center justify-center', bgColor)}>
      <div className="scale-[2.5]">{fallbackIcon}</div>
    </div>
  );

  return (
    <>
      <div className="hidden md:inline-flex">
        <HoverCard openDelay={300} closeDelay={100}>
          <HoverCardTrigger asChild>
            <span className="inline-flex">{children}</span>
          </HoverCardTrigger>
          <HoverCardContent
            className="w-80 max-w-[calc(100vw-2rem)] border-border/60 p-3"
            side="top"
            align="center"
            sideOffset={8}
          >
            <PreviewContent
              name={name}
              type={type}
              thumbnailPath={thumbnailPath}
              previewImagePaths={previewImagePaths}
              fallbackIcon={scaledFallbackIcon}
              onRemove={onRemove}
              showCloseButton={false}
            />
          </HoverCardContent>
        </HoverCard>
      </div>

      <div className="inline-flex md:hidden">
        <span
          role="button"
          tabIndex={0}
          onClick={() => setMobileDialogOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setMobileDialogOpen(true); }}
          className="inline-flex cursor-pointer"
        >
          {children}
        </span>
        <Dialog open={mobileDialogOpen} onOpenChange={setMobileDialogOpen}>
          <DialogContent
            layout="viewport"
            className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-sm overflow-y-auto p-3 sm:max-w-sm sm:p-4"
            showCloseButton={false}
          >
            <DialogTitle className="sr-only">{name}</DialogTitle>
            <DialogDescription className="sr-only">
              Preview for {type} reference: {name}
            </DialogDescription>
            <PreviewContent
              name={name}
              type={type}
              thumbnailPath={thumbnailPath}
              previewImagePaths={previewImagePaths}
              fallbackIcon={scaledFallbackIcon}
              onRemove={handleRemove}
              showCloseButton={true}
            />
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
