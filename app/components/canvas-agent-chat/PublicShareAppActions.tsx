'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { readPublicShareAppData, type PublicShareAppData } from '@/app/lib/tool-apps/public-share-data';
import type { BuiltinToolAppDescriptor } from '@/app/lib/tool-apps/types';

export function PublicShareAppActions({ data, app, sessionId, agentId, update, refresh }: {
  data: PublicShareAppData; app: BuiltinToolAppDescriptor; sessionId: string; agentId: string;
  update: (data: PublicShareAppData) => void; refresh: () => void;
}) {
  const t = useTranslations('chat.toolApp');
  const router = useRouter();
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'shareCopied' | 'shareCopyFailed' | 'shareInactive' | 'unavailable' | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  useEffect(() => {
    if (data.status !== 'active' || !data.expiresAt) return;
    const timer = setTimeout(refresh, Math.max(0, Math.min(2_147_483_647, Date.parse(data.expiresAt) - Date.now() + 50)));
    return () => clearTimeout(timer);
  }, [data.expiresAt, data.status, refresh]);

  const currentShare = async (signal: AbortSignal) => {
    const response = await fetch('/api/chat/tool-apps', { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ action: 'refresh', app, sessionId, agentId }),
    });
    const body = await response.json();
    const next = response.ok && body.success ? readPublicShareAppData(body.data) : null;
    if (signal.aborted) throw new Error('aborted');
    if (!next || next.id !== data.id) { setNotice('unavailable'); throw new Error('unavailable'); }
    update(next);
    return next;
  };
  const act = async (action: 'copy' | 'manage') => {
    if (request.current) return;
    const abort = new AbortController(); request.current = abort; setBusy(true); setNotice(null);
    try {
      if (action === 'copy') {
        const verified = currentShare(abort.signal).then(next => {
          if (!next.publicUrl || next.status !== 'active' || (next.expiresAt && Date.parse(next.expiresAt) <= Date.now())) {
            setNotice('shareInactive'); throw new Error('inactive');
          }
          if (new URL(next.publicUrl).origin !== window.location.origin) throw new Error('origin');
          return next.publicUrl;
        });
        // Start clipboard access in the click event; Safari retains user activation this way.
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          const blob = verified.then(url => new Blob([url], { type: 'text/plain' }));
          // Observe both promises even if clipboard access rejects synchronously.
          void blob.catch(() => undefined);
          const writing = async () => navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
          await Promise.all([verified, writing()]);
        } else {
          const url = await verified;
          await navigator.clipboard.writeText(url);
        }
        if (!abort.signal.aborted) setNotice('shareCopied');
      } else {
        const next = await currentShare(abort.signal);
        const store = useWorkspaceStore.getState();
        await store.hydrateWorkspaces();
        if (abort.signal.aborted) return;
        const switched = useWorkspaceStore.getState().activeWorkspaceId !== next.workspaceId
          && await store.setActiveWorkspace(next.workspaceId, 'chat');
        // The requested workspace switch can close this chat; finish its navigation.
        if (abort.signal.aborted && !switched) return;
        if (useWorkspaceStore.getState().activeWorkspaceId !== next.workspaceId) throw new Error('workspace');
        router.push(`/security/public-shares?status=all&q=${encodeURIComponent(next.workspacePath)}`);
      }
    } catch {
      if (!abort.signal.aborted) setNotice(previous => previous || (action === 'copy' ? 'shareCopyFailed' : 'unavailable'));
    } finally { if (!abort.signal.aborted) { request.current = null; setBusy(false); } }
  };
  return <div className="space-y-2 border-t px-4 py-3">
    <div className="flex flex-wrap gap-2">
      {data.status === 'active' && notice !== 'unavailable' ? <Button size="xs" variant="outline" disabled={busy}
        onClick={() => void act('copy')}>{t('shareCopy')}</Button> : null}
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act('manage')}>{t('shareManage')}</Button>
      <Button size="xs" variant="ghost" disabled={busy} onClick={refresh}>{t('reload')}</Button>
    </div>
    {notice ? <p className="text-xs text-muted-foreground" role="status">{t(notice)}</p> : null}
  </div>;
}
