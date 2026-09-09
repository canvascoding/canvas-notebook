import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { readTextWindow } from './text-read-window';

export type TextReadResultRange = {
  offset: number;
  nextOffset: number;
  totalChars: number;
  eof: boolean;
};

export function formatTextReadResult(body: string, range: TextReadResultRange, sha256: string, sourceNote = '') {
  const prefix = `SHA-256: ${sha256}${sourceNote}\nOffset: ${range.offset}; nextOffset: ${range.nextOffset}; totalChars: ${range.totalChars}; eof: ${range.eof}\n\n`;
  const suffix = !range.eof ? `\n[...content truncated after ${range.nextOffset - range.offset} characters; continue with read using nextOffset]` : '';
  return { text: prefix + body + suffix, layout: { bodyStart: prefix.length, bodyEnd: prefix.length + body.length, sourceNote } };
}

/** Crop a server-created read window, recalculating nextOffset from visible text. */
export function resizeTextReadResult(message: AgentMessage, maxChars: number): AgentMessage | null {
  if (message.role !== 'toolResult' || message.toolName !== 'read') return null;
  const details = message.details as Record<string, unknown> | undefined;
  const layout = details?.toolOutputReadWindow as { bodyStart: number; bodyEnd: number; sourceNote?: string } | undefined;
  if (!layout || !Number.isSafeInteger(layout.bodyStart) || !Number.isSafeInteger(layout.bodyEnd)
    || typeof details?.offset !== 'number' || typeof details?.totalChars !== 'number' || typeof details?.sha256 !== 'string') return null;
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  if (layout.bodyStart < 0 || layout.bodyEnd < layout.bodyStart || layout.bodyEnd > text.length) return null;
  const body = text.slice(layout.bodyStart, layout.bodyEnd);
  let length = Math.min(body.length, maxChars);
  let formatted: ReturnType<typeof formatTextReadResult>;
  let range: TextReadResultRange;
  do {
    const window = readTextWindow(body, 0, length);
    range = { offset: details.offset, nextOffset: details.offset + window.text.length,
      totalChars: details.totalChars, eof: details.offset + window.text.length === details.totalChars };
    formatted = formatTextReadResult(window.text, range, details.sha256, layout.sourceNote);
    if (formatted.text.length <= maxChars || length === 0) break;
    length = Math.max(0, length - (formatted.text.length - maxChars));
  } while (true);
  return { ...message, content: [{ type: 'text', text: formatted.text }, ...message.content.filter(block => block.type !== 'text')],
    details: { ...details, ...range, truncated: range.offset > 0 || !range.eof, toolOutputReadWindow: formatted.layout } };
}
