'use client';

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import { Trash2, X } from 'lucide-react';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export type ReferenceType = 'product' | 'persona' | 'style' | 'preset' | 'file';

interface ReferenceHoverCardProps {
  children: React.ReactNode;
  name: string;
  type: ReferenceType;
  thumbnailPath?: string;
  fallbackIcon: React.ReactNode;
  borderColor: string;
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
  const previewUrl = thumbnailPath ? toPreviewUrl(thumbnailPath, 400) : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-[280px] w-[280px] overflow-hidden rounded-md bg-muted">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={name}
            className="h-full w-full object-cover"
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            {fallbackIcon}
          </div>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className={cn(
            'absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10 text-destructive shadow-sm backdrop-blur-sm transition-colors hover:bg-destructive/20',
          )}
          title="Remove reference"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center gap-2 px-1">
        <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', TYPE_BADGE_COLORS[type])}>
          {TYPE_LABELS[type]}
        </span>
        <span className="truncate text-sm font-medium">{name}</span>
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
  borderColor,
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
      <div className="hidden md:block">
        <HoverCard openDelay={300} closeDelay={100}>
          <HoverCardTrigger asChild>
            {children}
          </HoverCardTrigger>
          <HoverCardContent
            className="w-auto p-3 border-border/60"
            side="top"
            align="start"
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

      <div className="block md:hidden">
        <button
          type="button"
          onClick={() => setMobileDialogOpen(true)}
          className="cursor-pointer"
        >
          {children}
        </button>
        <Dialog open={mobileDialogOpen} onOpenChange={setMobileDialogOpen}>
          <DialogContent
            className="max-w-[320px] p-4 sm:max-w-[320px]"
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