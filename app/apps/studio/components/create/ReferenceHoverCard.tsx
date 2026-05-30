'use client';

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import { Trash2 } from 'lucide-react';
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
        src={previewUrl}
        alt={name}
        className={cn(
          'relative z-[1] block h-auto max-h-[min(52dvh,360px)] w-auto max-w-full object-contain transition-opacity duration-300',
          imageStatus === 'loaded' ? 'opacity-100' : 'opacity-0',
        )}
        loading="lazy"
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
  fallbackIcon,
  onRemove,
  showCloseButton,
}: {
  name: string;
  type: ReferenceType;
  thumbnailPath?: string;
  fallbackIcon: React.ReactNode;
  onRemove: () => void;
  showCloseButton: boolean;
}) {
  const previewUrl = thumbnailPath ? toPreviewUrl(thumbnailPath, 320, { preset: 'mini' }) : undefined;

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
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className={cn(
            'absolute top-2 right-2 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-destructive/10 text-destructive shadow-sm backdrop-blur-sm transition-colors hover:bg-destructive/20',
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
