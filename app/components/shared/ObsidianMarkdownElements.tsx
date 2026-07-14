'use client';

import React, { useId } from 'react';
import { AlertTriangle, Info } from 'lucide-react';

import { cn } from '@/lib/utils';

type ObsidianCalloutProps = React.HTMLAttributes<HTMLElement> & {
  children?: React.ReactNode;
  fold?: string;
  title?: string;
  type?: string;
};

function CalloutTitle({ title, type }: { title: string; type: string }) {
  const Icon = /^(?:warning|danger|error|failure|bug)$/u.test(type) ? AlertTriangle : Info;
  return (
    <span className="flex min-w-0 items-center gap-2 font-semibold text-foreground">
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{title}</span>
    </span>
  );
}

export function ObsidianCallout({
  children,
  className,
  fold,
  title = 'Note',
  type = 'note',
  ...props
}: ObsidianCalloutProps) {
  const calloutClasses = cn(
    'my-3 rounded-lg border border-border/80 bg-muted/25 px-3 py-2 text-foreground',
    /^(?:warning|danger|error|failure|bug)$/u.test(type) && 'border-amber-500/35 bg-amber-500/5',
    className,
  );

  if (fold === '+' || fold === '-') {
    return (
      <details className={calloutClasses} open={fold === '+'} {...props}>
        <summary className="cursor-pointer list-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <CalloutTitle title={title} type={type} />
        </summary>
        <div className="mt-2 border-t border-border/60 pt-2">{children}</div>
      </details>
    );
  }

  return (
    <aside className={calloutClasses} {...props}>
      <CalloutTitle title={title} type={type} />
      <div className="mt-2 border-t border-border/60 pt-2">{children}</div>
    </aside>
  );
}

export function ObsidianInlineFootnote({
  content,
  index,
}: {
  content: string;
  index: number | string;
}) {
  const tooltipId = useId();
  return (
    <span className="group relative inline-flex align-super">
      <button
        type="button"
        aria-describedby={tooltipId}
        className="rounded-sm px-0.5 text-[0.7em] font-semibold leading-none text-primary outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring"
      >
        [{index}]
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="invisible absolute bottom-full left-1/2 z-[110] mb-2 w-max max-w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs font-normal leading-relaxed text-popover-foreground opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}
