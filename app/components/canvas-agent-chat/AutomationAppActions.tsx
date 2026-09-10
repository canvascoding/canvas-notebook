'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { readAutomationAppData, type AutomationAppData } from '@/app/lib/tool-apps/automation-data';
import type { BuiltinToolAppDescriptor } from '@/app/lib/tool-apps/types';

export function AutomationAppActions({ data, app, sessionId, agentId, update, refresh }: {
  data: AutomationAppData; app: BuiltinToolAppDescriptor; sessionId: string; agentId: string;
  update: (data: AutomationAppData) => void; refresh: () => void;
}) {
  const t = useTranslations('chat.toolApp');
  const locale = useLocale();
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'changed' | 'conflict' | 'chatBusy' | 'callFailed' | 'unavailable' | null>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => () => { request.current?.abort(); }, []);
  const changeStatus = async () => {
    if (request.current || blocked || !data.canChangeStatus) return;
    const abort = new AbortController(); request.current = abort; setBusy(true); setNotice(null);
    try {
      const response = await fetch('/api/chat/tool-apps', { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, signal: abort.signal,
        body: JSON.stringify({ action: 'status', sessionId, agentId, app, expectedRevision: data.revision, expectedUpdatedAt: data.updatedAt,
          status: data.status === 'active' ? 'paused' : 'active', locale: locale.startsWith('de') ? 'de' : 'en' }),
      });
      const body = await response.json();
      if (abort.signal.aborted) return;
      const next = response.ok && body.success ? readAutomationAppData(body.data) : null;
      if (!next || next.id !== data.id) {
        setBlocked(true);
        setNotice(body.code === 'TOOL_APP_CHAT_BUSY' ? 'chatBusy' : response.status === 409 ? 'conflict'
          : [401, 403, 404].includes(response.status) ? 'unavailable' : 'callFailed');
        return;
      }
      update(next); setNotice('changed');
      window.dispatchEvent(new CustomEvent('agent_event', { detail: { sessionId, event: { type: 'message_saved' } } }));
    } catch { if (!abort.signal.aborted) { setNotice('callFailed'); setBlocked(true); } }
    finally { if (!abort.signal.aborted) { request.current = null; setBusy(false); } }
  };
  const href = `/automations/${encodeURIComponent(data.id)}`;
  return <div className="space-y-2 border-t px-4 py-3">
    {notice !== 'unavailable' ? <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" variant="outline" asChild><Link href={href}>{t('open')}</Link></Button>
      <Button size="xs" variant="ghost" asChild><Link href={`${href}?edit=1`}>{t('edit')}</Link></Button>
      {data.canChangeStatus ? <Button size="xs" variant="ghost" disabled={busy || blocked}
        onClick={() => void changeStatus()}>{t(busy ? 'saving' : data.status === 'active' ? 'pause' : 'resume')}</Button> : null}
    </div> : null}
    {notice ? <p className="text-xs text-muted-foreground" role="status">{t(notice)}</p> : null}
    {blocked ? <Button size="xs" variant="outline" onClick={refresh}>{t('reload')}</Button> : null}
    {!data.canChangeStatus && !notice ? <p className="text-xs text-muted-foreground">{t('statusUnavailable')}</p> : null}
  </div>;
}
