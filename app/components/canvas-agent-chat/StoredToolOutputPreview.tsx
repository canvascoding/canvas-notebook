'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { getToolOutputMetadata, type ToolOutputMetadata } from '@/app/lib/pi/tool-output-metadata';

export type ToolOutputScope = { sessionId: string; agentId: string; workspaceId: string };
type Page = { content: string; offset: number; nextOffset: number; totalChars: number; eof: boolean };

export function StoredToolOutputPreview({ details, scope }: { details: unknown; scope?: ToolOutputScope }) {
  const metadata = getToolOutputMetadata(details);
  if (!metadata || (!metadata.references.length && !metadata.storageError && metadata.sourceCount === undefined)) return null;
  return <StoredToolOutputPreviewContent key={JSON.stringify([scope, metadata.references.map((ref) => ref.reference)])} metadata={metadata} scope={scope} />;
}

function StoredToolOutputPreviewContent({ metadata, scope }: { metadata: ToolOutputMetadata; scope?: ToolOutputScope }) {
  const t = useTranslations('chat.storedOutput');
  const [page, setPage] = useState<Page | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [offset, setOffset] = useState('0');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function load(index: number, start: number) {
    if (!scope || !metadata || !Number.isSafeInteger(start) || start < 0) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setSelected(index); setOffset(String(start)); setLoading(true); setError(false); setPage(null);
    try {
      const query = new URLSearchParams({ agentId: scope.agentId, workspaceId: scope.workspaceId,
        reference: metadata.references[index].reference, offset: String(start) });
      const response = await fetch(`/api/sessions/${encodeURIComponent(scope.sessionId)}/tool-output?${query}`, {
        cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error('unavailable');
      const result = await response.json() as Page;
      if (controller.signal.aborted) return;
      setPage(result); setOffset(String(result.offset));
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }

  return <div className="mb-3 space-y-2 text-xs" data-testid="stored-tool-output">
    {metadata.sourceCount !== undefined && <p className="text-muted-foreground">{t('sources', { shown: metadata.shownCount ?? metadata.sourceCount, total: metadata.sourceCount })}</p>}
    {metadata.references.length > 0 && <p>{!metadata.storageError && metadata.references.every((ref) => ref.complete) ? t('available') : t('partial')}</p>}
    {metadata.storageError && <p role="alert">{t('storageFailed')}</p>}
    {!scope && metadata.references.length > 0 && <p>{t('scopeMissing')}</p>}
    <div className="flex flex-wrap gap-2">
      {metadata.references.map((ref, index) => <Button key={ref.reference} type="button" variant="outline" size="sm"
        disabled={!scope || loading} onClick={() => void load(index, 0)} title={ref.title}>
        {t('open', { number: index + 1 })}
      </Button>)}
    </div>
    {loading && <p role="status">{t('loading')}</p>}
    {error && <div role="alert">{t('loadFailed')} <Button type="button" variant="outline" size="sm" onClick={() => selected !== null && void load(selected, Number(offset))}>{t('retry')}</Button></div>}
    {page && selected !== null && <div className="space-y-2 rounded-md border p-2">
      <p>{t('range', { start: page.offset, end: page.nextOffset, total: page.totalChars })}</p>
      <pre data-testid="stored-tool-output-content" className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{page.content}</pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={page.offset === 0} onClick={() => void load(selected, Math.max(0, page.offset - 6000))}>{t('previous')}</Button>
        <Button type="button" variant="outline" size="sm" disabled={page.eof} onClick={() => void load(selected, page.nextOffset)}>{t('next')}</Button>
        <label className="flex items-center gap-2">{t('offset')}<input type="number" min="0" max={page.totalChars} value={offset}
          onChange={(event) => setOffset(event.target.value)} className="w-28 rounded border bg-background p-1" /></label>
        <Button type="button" variant="outline" size="sm" disabled={!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))} onClick={() => void load(selected, Number(offset))}>{t('jump')}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => { setPage(null); setSelected(null); }}>{t('close')}</Button>
      </div>
    </div>}
  </div>;
}
