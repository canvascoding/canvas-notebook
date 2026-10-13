'use client';

import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import type { CapabilityPackageOwnedDraftList, CapabilityPackageOwnedDraftStatus } from '@/app/lib/capabilities/packages/contracts';
import { usePluginEditorNavigationGuard } from './plugin-navigation-guard';
import { PluginExtensionAvatar } from './PluginExtensionAvatar';

type DraftResponse = { success: boolean; data?: CapabilityPackageOwnedDraftList; code?: string };

/** Creator-private navigation; opening still delegates to the current package authorization. */
export function PackageDraftsSection({ workspaceId, onOpenDraft, showHeader = true }: {
  workspaceId?: string | null; onOpenDraft: (status: CapabilityPackageOwnedDraftStatus) => void; showHeader?: boolean;
}) {
  const t = useTranslations('skills.drafts'), locale = useLocale();
  const contextKey = workspaceId || '';
  const [loadedContext, setLoadedContext] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<CapabilityPackageOwnedDraftStatus[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<string | null>(null);
  usePluginEditorNavigationGuard({ dirty: false, pending: pendingDraft !== null });
  const [error, setError] = useState<'requestError' | 'accessError' | 'conflict' | null>(null);
  const [notice, setNotice] = useState(false);
  const generation = useRef(0), requestSequence = useRef(0);
  const readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null);
  const currentContext = loadedContext === contextKey;
  const visibleDrafts = currentContext ? drafts : [];

  const apiPath = useCallback((draftRef?: string, cursor?: string) => {
    const parameters = new URLSearchParams();
    if (workspaceId) parameters.set('workspaceId', workspaceId);
    if (!draftRef) parameters.set('limit', '20');
    if (cursor) parameters.set('cursor', cursor);
    return `/api/capabilities/packages/drafts${draftRef ? `/${encodeURIComponent(draftRef)}` : ''}?${parameters}`;
  }, [workspaceId]);

  const load = useCallback(async (cursor?: string) => {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const current = generation.current, sequence = ++requestSequence.current;
    setLoading(true); setError(null); setNotice(false);
    try {
      const response = await fetch(apiPath(undefined, cursor), { cache: 'no-store', signal: controller.signal });
      const payload = await response.json() as DraftResponse;
      if (current !== generation.current || sequence !== requestSequence.current || controller.signal.aborted) return;
      if (!response.ok || !payload.success || !payload.data || !Array.isArray(payload.data.drafts)) {
        setError(response.status === 403 || response.status === 401 ? 'accessError' : 'requestError');
        if (!cursor) { setDrafts([]); setNextCursor(null); setLoadedContext(contextKey); }
        return;
      }
      const list = payload.data;
      setDrafts(previous => cursor ? [...previous, ...list.drafts.filter(draft => !previous.some(item => item.draftRef === draft.draftRef))] : list.drafts);
      setNextCursor(list.nextCursor); setLoadedContext(contextKey);
    } catch {
      if (current === generation.current && sequence === requestSequence.current && !controller.signal.aborted) {
        setError('requestError');
        if (!cursor) { setDrafts([]); setNextCursor(null); setLoadedContext(contextKey); }
      }
    } finally {
      if (current === generation.current && sequence === requestSequence.current && !controller.signal.aborted) setLoading(false);
    }
  }, [apiPath, contextKey]);

  useEffect(() => {
    startTransition(() => {
      setLoadedContext(null); setDrafts([]); setNextCursor(null); setPendingDraft(null); setNotice(false);
      void load();
    });
    return () => { generation.current += 1; readController.current?.abort(); writeController.current?.abort(); };
  }, [load]);

  const discard = async (draft: CapabilityPackageOwnedDraftStatus) => {
    const current = generation.current, controller = new AbortController();
    writeController.current = controller;
    setPendingDraft(draft.draftRef); setError(null); setNotice(false);
    try {
      const response = await fetch(apiPath(draft.draftRef), { method: 'DELETE', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedDraftRevision: draft.draftRevision }) });
      const payload = await response.json() as { success: boolean };
      if (current !== generation.current || controller.signal.aborted) return;
      if (!response.ok || !payload.success) {
        setError(response.status === 409 ? 'conflict' : response.status === 403 || response.status === 401 ? 'accessError' : 'requestError');
        return;
      }
      setDrafts(previous => previous.filter(item => item.draftRef !== draft.draftRef)); setNotice(true);
    } catch {
      if (current === generation.current && !controller.signal.aborted) setError('requestError');
    } finally {
      if (current === generation.current && !controller.signal.aborted) setPendingDraft(null);
    }
  };

  const updatedLabel = (timestamp: number) => {
    const date = new Date(timestamp);
    return t('updated', { date: Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : '—' });
  };

  return <section data-testid="package-drafts-section" className="min-w-0 space-y-4" aria-busy={loading || pendingDraft !== null}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      {showHeader && <div className="min-w-0"><h2 className="text-lg font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('description')}</p></div>}
      <Button variant="outline" onClick={() => void load()} disabled={loading || pendingDraft !== null}>{t('refresh')}</Button>
    </div>
    {error && <InlineNotice variant="warning" size="compact" role="alert">{t(error)}</InlineNotice>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{t('discarded')}</p>}
    {!currentContext || loading && visibleDrafts.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>
      : visibleDrafts.length === 0 && !error ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : null}
    <ul className="space-y-3">
      {visibleDrafts.map(draft => <li key={draft.draftRef} data-testid="package-draft-row" className="min-w-0 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PluginExtensionAvatar name={draft.name} identity={JSON.stringify([draft.draftRef, workspaceId ?? '', draft.draftRevision])} size="sm" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="break-words font-medium">{draft.name}</p>
            <p className="text-xs text-muted-foreground">{t(draft.kind)} · {t(draft.operation)} · {t(draft.targetOwnership.type === 'user' ? 'personal' : draft.targetOwnership.type)}</p>
            <p className="text-xs text-muted-foreground">{updatedLabel(draft.updatedAt)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => onOpenDraft(draft)} disabled={loading || pendingDraft !== null}>{t('open')}</Button>
            <Button variant="ghost" onClick={() => void discard(draft)} disabled={loading || pendingDraft !== null}>
              {pendingDraft === draft.draftRef ? t('pending') : t('discard')}
            </Button>
          </div>
        </div>
      </li>)}
    </ul>
    {currentContext && nextCursor && <Button variant="outline" onClick={() => void load(nextCursor)} disabled={loading || pendingDraft !== null}>{t('loadMore')}</Button>}
  </section>;
}
