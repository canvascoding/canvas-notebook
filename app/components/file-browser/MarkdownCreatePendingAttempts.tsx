'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthenticatedRequestScope } from '@/app/components/auth/AuthenticatedSessionBoundary';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { hideMarkdownCreateAttempt, hydrateMarkdownCreateAttempts, useMarkdownCreateStore } from '@/app/store/markdown-create-store';
import type { ManualMarkdownCreateAttempt } from '@/app/lib/files/markdown-create-result';

export function MarkdownCreatePendingAttempts({ workspaceId, disabled, onResume }: {
  workspaceId: string | null;
  disabled?: boolean;
  onResume: (attempt: ManualMarkdownCreateAttempt) => Promise<void>;
}) {
  const t = useTranslations('notebook');
  const { scope, active } = useAuthenticatedRequestScope();
  const activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const records = useMarkdownCreateStore(state => state.attempts);
  useEffect(() => { if (active && scope) hydrateMarkdownCreateAttempts(scope); }, [active, scope]);
  if (!active || !scope) return null;
  const attempts = Object.values(records).filter(entry => entry.scope === scope);
  if (!attempts.length) return null;
  return <div className="space-y-2" aria-label={t('markdownCreatePendingTitle')}>
    {attempts.map(attempt => {
      const canResume = attempt.workspaceId === workspaceId && activeWorkspaceId === workspaceId;
      return <div key={JSON.stringify([attempt.workspaceId, attempt.requestId])} className="rounded-md border p-3 text-sm">
      <p className="break-words font-medium">{attempt.targetPath}</p>
      {attempt.workspaceId !== activeWorkspaceId ? <p className="mt-1 text-xs text-muted-foreground">{t('markdownCreateOtherWorkspace')}</p> : null}
      <p className="mt-1 text-xs text-muted-foreground" role="status">{attempt.busy ? t('markdownCreateChecking') : {
        unconfirmed: t('markdownCreateUnconfirmed'), projection_pending: t('markdownCreateProjectionPending'),
        recovery_required: t('markdownCreateRecoveryRequired'), unavailable: t('markdownCreateUnavailable'),
      }[attempt.status]}</p>
      <Button type="button" size="sm" variant="outline" className="mt-2" disabled={disabled || attempt.busy || !canResume}
        onClick={() => { if (canResume) void onResume(attempt); }}>
        {attempt.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{t('markdownCreateResume')}
      </Button>
      <Button type="button" size="sm" variant="ghost" className="ml-2 mt-2" disabled={disabled || attempt.busy}
        onClick={() => hideMarkdownCreateAttempt(attempt)}>{t('markdownCreateHide')}</Button>
      <p className="mt-1 text-xs text-muted-foreground">{t('markdownCreateHideHint')}</p>
    </div>; })}
  </div>;
}
