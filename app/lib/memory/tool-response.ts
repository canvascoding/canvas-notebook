import type { MemoryEntry, MemoryReadResult } from './service';

const MAX_READ_ENTRIES = 20;
const MAX_READ_CHARS = 6_000;

/** Bound model-visible memory inventory independently of the system-prompt budget. */
export function formatMemoryToolRead(result: MemoryReadResult, offset = 0): {
  text: string;
  entries: MemoryEntry[];
  omittedCount: number;
  nextOffset: number | null;
} {
  const label = `${result.target[0].toUpperCase()}${result.target.slice(1)} memory`;
  if (result.entries.length === 0) {
    return { text: `${label} has no stored entries.`, entries: [], omittedCount: 0, nextOffset: null };
  }
  const start = Math.min(Math.max(0, Math.floor(offset)), result.entries.length);
  if (start === result.entries.length) {
    return { text: `${label} has ${result.entries.length} entries; offset ${start} is past the end.`, entries: [], omittedCount: 0, nextOffset: null };
  }
  const lines = [`${label} entries starting at ${start + 1} of ${result.entries.length}:`];
  const entries: MemoryEntry[] = [];
  let length = lines[0].length;
  for (const entry of result.entries.slice(start)) {
    const line = `- [${entry.id}] ${entry.content} (${entry.status})`;
    if (entries.length >= MAX_READ_ENTRIES || length + line.length + 1 > MAX_READ_CHARS) break;
    lines.push(line);
    entries.push(entry);
    length += line.length + 1;
  }
  const nextOffset = start + entries.length < result.entries.length ? start + entries.length : null;
  const omittedCount = result.entries.length - start - entries.length;
  if (nextOffset !== null) {
    lines.push(`... ${omittedCount} more entries. Read the next page with memory(action="read", target="${result.target}", offset=${nextOffset}), or manage the full list in /settings?tab=memory&scope=${result.target}.`);
  }
  return { text: lines.join('\n'), entries, omittedCount, nextOffset };
}

/** A write confirms the affected entry without replaying the entire collection. */
export function formatMemoryToolWrite(result: {
  changed: boolean;
  entry?: MemoryEntry;
  archivedEntry?: MemoryEntry;
  entries: MemoryEntry[];
}): string {
  const affected = result.entry ?? result.archivedEntry;
  const lines = [
    affected ? `Entry: [${affected.id}] ${affected.content}` : 'No entry changed.',
    `Active entries in this scope: ${result.entries.length}.`,
  ];
  return lines.join('\n');
}
