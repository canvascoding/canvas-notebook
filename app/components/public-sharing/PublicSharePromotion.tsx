'use client';

import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';

const CANVAS_NOTEBOOK_URL = 'https://canvasnotebook.app';

export function PublicSharePromotion() {
  return (
    <footer
      aria-label="Canvas Notebook"
      className="flex min-h-9 shrink-0 items-center justify-center border-t border-border/70 bg-background/95 px-3 py-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] text-[11px] text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-background/85"
      data-public-share-promotion
    >
      <a
        href={CANVAS_NOTEBOOK_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Create your own Canvas Notebook (opens in a new tab)"
        className="group inline-flex min-w-0 max-w-full items-center gap-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Image
          src="/images/bradley/bradley-icon.svg"
          alt=""
          aria-hidden="true"
          width={18}
          height={18}
          loading="lazy"
          decoding="async"
          className="h-[18px] w-[18px] shrink-0 opacity-80 transition-opacity group-hover:opacity-100"
        />
        <span className="truncate">
          Shared with <span className="font-medium text-foreground/80">Canvas Notebook</span>
        </span>
        <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
        <span className="shrink-0 font-medium text-foreground/70 group-hover:text-foreground">
          Create your own
        </span>
        <ArrowUpRight
          aria-hidden="true"
          className="h-3 w-3 shrink-0 transition-transform group-hover:-translate-y-px group-hover:translate-x-px"
        />
      </a>
    </footer>
  );
}
