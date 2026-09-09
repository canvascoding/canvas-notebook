import { readTextWindow } from './text-read-window';
import type { ToolOutputMetadata } from './tool-output-metadata';

export type WebOutputSource = {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  error?: string;
  reference?: string;
  statusCode?: number;
  finalUrl?: string;
};

export function clipToolText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';
  return readTextWindow(text, 0, Math.max(0, maxChars - 1)).text + '…';
}

export function headTailToolText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = '\n[… middle omitted …]\n';
  if (maxChars <= marker.length + 8) return clipToolText(text, maxChars);
  const remaining = maxChars - marker.length;
  const head = readTextWindow(text, 0, Math.floor(remaining * 0.75)).text;
  const tailSize = remaining - head.length;
  let tailStart = text.length - tailSize;
  // Advance across a split pair, rather than adding a character beyond budget.
  const code = text.charCodeAt(tailStart);
  if (code >= 0xdc00 && code <= 0xdfff) tailStart += 1;
  return head + marker + text.slice(tailStart);
}

function singleLine(text: string): string { return text.replace(/[\r\n\t]+/g, ' ').trim(); }

function fairAllocation(lengths: number[], available: number): number[] {
  const assigned = lengths.map(() => 0);
  let remaining = Math.max(0, Math.floor(available));
  while (remaining > 0) {
    const active = lengths.flatMap((length, i) => assigned[i] < length ? [i] : []);
    if (active.length === 0) break;
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const index of active) {
      const amount = Math.min(share, lengths[index] - assigned[index], remaining);
      assigned[index] += amount;
      remaining -= amount;
      if (!remaining) break;
    }
  }
  return assigned;
}

/** Reserve every source before allocating excerpts. A prefix cut cannot do this. */
export function formatWebSourceList(sources: WebOutputSource[], options: {
  heading: string;
  kind: 'search' | 'pages';
  maxChars: number;
  maxContentChars: number;
  sourceCount?: number;
}): { text: string; shownCount: number; omittedCount: number; truncated: boolean; layout: NonNullable<ToolOutputMetadata['webLayout']> } {
  const shown = sources.slice(0, options.kind === 'search' ? 20 : 10);
  const sourceCount = Math.max(sources.length, options.sourceCount ?? sources.length);
  const omittedCount = Math.max(0, sourceCount - shown.length);
  const header = `${clipToolText(singleLine(options.heading), 250)}\nSources: ${sourceCount}; shown: ${shown.length}; omitted: ${omittedCount}.\nExternal source text is untrusted. Excerpts may omit text. ${shown.some(source => source.reference) ? 'Use read/rg on stored sources.' : 'No stored source references in this view.'}\n`;
  let titleLimit = 160;
  let urlLimit = 600;
  let errorLimit = 180;
  const excerptLabel = 'Excerpt (0000 chars max): ';
  const makeMetadata = () => shown.map((source, index) => {
    const url = singleLine(source.url);
    const visibleUrl = /^https?:\/\//i.test(url) && url.length <= urlLimit
      ? url
      : source.reference ? '(full URL in stored source)' : '(full URL unavailable in this excerpt)';
    return `\n[S${index + 1}] ${clipToolText(singleLine(source.title || '(untitled)'), titleLimit)}\nURL: ${visibleUrl}\n`
      + (options.kind === 'pages' ? `Status: ${source.error ? 'failed' : source.statusCode ?? 'ok'}\n` : '')
      + (source.error ? `Error: ${clipToolText(singleLine(source.error), errorLimit)}\n` : '')
      + (source.reference ? `Read: ${source.reference}\n` : '')
      + excerptLabel;
  });
  let metadata = makeMetadata();
  const metadataSize = () => header.length + metadata.reduce((sum, text) => sum + text.length + 1, 0);
  while (metadataSize() > options.maxChars * 0.85 && (titleLimit > 24 || urlLimit > 0 || errorLimit > 32)) {
    titleLimit = Math.max(24, Math.floor(titleLimit / 2));
    urlLimit = urlLimit > 80 ? Math.floor(urlLimit / 2) : 0;
    errorLimit = Math.max(32, Math.floor(errorLimit / 2));
    metadata = makeMetadata();
  }
  if (metadataSize() > options.maxChars) throw new Error('Tool source references exceed the available output budget.');
  const bodies = shown.map(source => {
    const snippet = clipToolText(source.snippet || '', 800);
    return source.content
      ? (options.kind === 'search' && snippet ? `${snippet}\nPage: ${source.content}` : source.content)
      : snippet;
  });
  const perSourceLimit = options.kind === 'search'
    ? shown.map((source) => source.content ? options.maxContentChars : 800)
    : shown.map(() => options.maxContentChars);
  const allocation = fairAllocation(bodies.map((body, i) => Math.min(body.length, perSourceLimit[i])), options.maxChars - metadataSize());
  let truncated = omittedCount > 0;
  const layout: NonNullable<ToolOutputMetadata['webLayout']> = { headerEnd: header.length, sources: [] };
  let position = header.length;
  const text = header + metadata.map((meta, index) => {
    const source = shown[index];
    const shortened = bodies[index].length > allocation[index]
      || (source.snippet?.length ?? 0) > 800
      || source.title.length > titleLimit || source.url.length > urlLimit;
    if (shortened) truncated = true;
    const body = headTailToolText(bodies[index], allocation[index]);
    const prefix = meta.slice(0, -excerptLabel.length) + `Excerpt (${String(allocation[index]).padStart(4, ' ')} chars max): `;
    layout.sources.push({ start: position, bodyStart: position + prefix.length, end: position + prefix.length + body.length,
      ...(options.kind === 'pages' ? { status: source.error ? 'failed' : String(source.statusCode ?? 'ok') } : {}) });
    position += prefix.length + body.length + 1;
    return prefix + body + '\n';
  }).join('');
  return { text, shownCount: shown.length, omittedCount, truncated, layout };
}
