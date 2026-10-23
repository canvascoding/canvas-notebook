'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { parseWorkspaceStarterInitializationResult, type WorkspaceStarterInitializationResult } from '@/app/lib/workspaces/starter-document-initialization-contract';

export function readWorkspaceStarterInitializationResult(
  value: unknown,
  workspaceId: string,
): WorkspaceStarterInitializationResult | null {
  const result = parseWorkspaceStarterInitializationResult(value);
  return result?.workspaceId === workspaceId ? result : null;
}

/** The workspace already exists. Every request here targets that same workspace
 * and its saved attempt; this component never repeats workspace creation. */
export function WorkspaceStarterInitializationStatus({ initial }: { initial: WorkspaceStarterInitializationResult }) {
  const t = useTranslations('settings.workspacePanel.management.starterInitialization');
  const [initialization, setInitialization] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);

  const refresh = async (method: 'GET' | 'POST') => {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(initial.workspaceId)}/starter-document-initialization`, {
        method, credentials: 'include', cache: 'no-store',
        headers: { [WORKSPACE_ID_HEADER]: initial.workspaceId }, signal: controller.signal,
      });
      const payload = await response.json();
      const observed = readWorkspaceStarterInitializationResult(payload.starterDocumentInitialization, initial.workspaceId);
      if (!observed) throw new Error('WORKSPACE_STARTER_STATUS_UNCONFIRMED');
      if (!controller.signal.aborted) setInitialization(observed);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  if (initialization.status === 'completed' || initialization.status === 'not_required') return null;
  return (
    <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4" role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t(initialization.status === 'blocked' ? 'blockedTitle' : 'pendingTitle')}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(initialization.status === 'blocked' ? 'blockedDescription' : 'pendingDescription')}</p>
          {error ? <p className="mt-2 text-xs text-destructive" role="alert">{t('requestFailed')}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void refresh('GET')}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              {t('check')}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void refresh('POST')}>
              {t('resume')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
