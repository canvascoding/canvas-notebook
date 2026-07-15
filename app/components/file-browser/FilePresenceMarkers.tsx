'use client';

import { Bot } from 'lucide-react';

import { useFilePresenceStore } from '@/app/store/file-presence-store';

export function FilePresenceMarkers({ path }: { path: string }) {
  const entries = useFilePresenceStore((state) => state.byPath[path]);
  if (!entries) return null;
  if (entries.length === 0) return null;
  const shown = entries.slice(0, 3);
  const description = entries.map((entry) => `${entry.displayName}: ${entry.activity.replace('_', ' ')}`).join(', ');
  return (
    <span className="inline-flex shrink-0 -space-x-1" aria-label={`Active collaborators: ${description}`} title={description}>
      {shown.map((entry) => (
        <span
          key={`${entry.actorType}:${entry.userId}`}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-background text-[9px] font-semibold"
          style={{ backgroundColor: entry.colorLight, color: entry.color }}
          aria-hidden="true"
        >
          {entry.actorType === 'agent' ? <Bot className="h-3 w-3" /> : entry.displayName.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {entries.length > shown.length && (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-background bg-muted px-1 text-[9px] font-semibold text-muted-foreground" aria-hidden="true">
          +{entries.length - shown.length}
        </span>
      )}
    </span>
  );
}
