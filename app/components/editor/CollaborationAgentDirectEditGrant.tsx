'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { workspaceHeaders } from '@/app/lib/files/client';
import { Button } from '@/components/ui/button';

type DirectEditGrant = { id: string; expiresAt: number; active: boolean; revokedAt: number | null };
type GrantStatus = { canGrant: boolean; grant: DirectEditGrant | null };

function readGrant(value: unknown): DirectEditGrant | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const grant = value as Partial<DirectEditGrant>;
  return typeof grant.id === 'string' && grant.id.length > 0
    && typeof grant.expiresAt === 'number' && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > 0
    && typeof grant.active === 'boolean'
    && (grant.revokedAt === null || (typeof grant.revokedAt === 'number' && Number.isSafeInteger(grant.revokedAt)))
    ? grant as DirectEditGrant : undefined;
}

/** Mounted only in the deliberately opened agent panel, for the current user's operation. */
export function CollaborationAgentDirectEditGrant({ operationId }: { operationId: string }) {
  const t = useTranslations('notebook.collaboration');
  const [status, setStatus] = useState<GrantStatus | null>(null);
  const [observedAt, setObservedAt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<'granted' | 'revoked' | null>(null);
  const requestSequence = useRef(0);
  const actionInFlight = useRef(false);
  const actionKeys = useRef(new Map<string, string>());
  const endpoint = `/api/files/collaboration/operations/${encodeURIComponent(operationId)}/direct-edit-grant`;

  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++requestSequence.current;
    try {
      const response = await fetch(endpoint, { headers: workspaceHeaders(), cache: 'no-store', signal });
      const payload: unknown = await response.json();
      if (sequence !== requestSequence.current || signal?.aborted) return;
      if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)
        || !('success' in payload) || payload.success !== true || !('canGrant' in payload)
        || typeof payload.canGrant !== 'boolean' || !('grant' in payload)) throw new Error('Invalid grant status');
      const grant = readGrant(payload.grant);
      if (grant === undefined) throw new Error('Invalid grant status');
      setStatus({ canGrant: payload.canGrant, grant });
      setObservedAt(Date.now());
      setFailed(false);
      setMessage(null);
    } catch {
      if (sequence !== requestSequence.current || signal?.aborted) return;
      setStatus(null);
      setFailed(true);
    }
  }, [endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    let timeout: number | undefined;
    const poll = async () => {
      if (!actionInFlight.current) await load(controller.signal);
      if (!controller.signal.aborted) timeout = window.setTimeout(() => void poll(), 5_000);
    };
    void poll();
    return () => {
      controller.abort();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [load]);

  const change = async (action: 'grant' | 'revoke') => {
    if (!status || actionInFlight.current || (action === 'grant' && !status.canGrant)
      || (action === 'revoke' && (!status.grant || status.grant.revokedAt !== null))) return;
    const key = `${action}:${status.grant?.id ?? 'none'}:${status.grant?.revokedAt ?? ''}`;
    const idempotencyKey = actionKeys.current.get(key) || crypto.randomUUID();
    actionKeys.current.set(key, idempotencyKey);
    actionInFlight.current = true;
    requestSequence.current++;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
        body: JSON.stringify({ action, idempotencyKey }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)
        || !('success' in payload) || payload.success !== true || !('grant' in payload)) throw new Error('Grant action failed');
      const grant = readGrant(payload.grant);
      if (grant === undefined || (action === 'grant' && grant === null)
        || (action === 'revoke' && grant !== null && grant.revokedAt === null)) throw new Error('Invalid grant result');
      setStatus({ canGrant: status.canGrant, grant });
      setObservedAt(Date.now());
      setFailed(false);
      if (action === 'revoke') setMessage('revoked');
      else if (grant?.active && grant.revokedAt === null && grant.expiresAt > Date.now()) setMessage('granted');
    } catch {
      // Retain the action key: an uncertain response must never extend a prior grant on retry.
      setFailed(true);
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  };

  const grant = status?.grant;
  const active = grant?.active && grant.revokedAt === null && grant.expiresAt > observedAt;
  if (status && !status.canGrant && !grant) return null;

  return (
    <div className="mt-2 space-y-1.5 border-t pt-2 text-[11px] text-muted-foreground">
      <p className="font-medium text-foreground">{t('agentDirectEditTitle')}</p>
      <p>{t('agentDirectEditScope')}</p>
      {active && grant ? (
        <p>{t('agentDirectEditActiveUntil', { time: new Date(grant.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</p>
      ) : grant ? <p>{t('agentDirectEditInactive')}</p> : null}
      {message ? <p role="status">{t(message === 'granted' ? 'agentDirectEditGranted' : 'agentDirectEditRevoked')}</p> : null}
      {failed ? <p role="status">{t('agentDirectEditFailed')}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {status?.canGrant && !active ? (
          <Button type="button" size="sm" variant="outline" className="h-auto whitespace-normal px-2 py-1.5 text-left text-xs" disabled={busy} onClick={() => void change('grant')}>
            {t('agentDirectEditGrant')}
          </Button>
        ) : null}
        {grant && grant.revokedAt === null ? (
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void change('revoke')}>
            {t('agentDirectEditRevoke')}
          </Button>
        ) : null}
        {failed ? (
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void load()}>{t('agentDirectEditRefresh')}</Button>
        ) : null}
      </div>
    </div>
  );
}
