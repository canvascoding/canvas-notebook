'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function AutomationDisclosure({
  title,
  summary,
  children,
  defaultOpen = false,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group/disclosure min-w-0 border-t border-border/70"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 py-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="font-medium">{title}</span>
        {summary ? (
          <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
        ) : null}
        <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/disclosure:rotate-180" />
      </summary>
      {open ? <div className="min-w-0 space-y-4 pb-5">{children}</div> : null}
    </details>
  );
}
