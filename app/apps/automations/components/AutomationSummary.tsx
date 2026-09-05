'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { MarkdownRenderer } from '@/app/components/shared/MarkdownRenderer';
import type { AutomationJobRecord, AutomationRunRecord } from '@/app/lib/automations/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AutomationDisclosure } from './AutomationDisclosure';
import type { AutomationAgentOption } from './AutomationAgentPicker';

export function AutomationSummary({
  job,
  agent,
  workspaceName,
  triggerLabel,
  latestRun,
  latestStatus,
  onOpenRun,
}: {
  job: AutomationJobRecord;
  agent?: AutomationAgentOption;
  workspaceName?: string;
  triggerLabel: string;
  latestRun?: AutomationRunRecord;
  latestStatus: string;
  onOpenRun: (runId: string) => void;
}) {
  const t = useTranslations('automationen');
  const locale = useLocale();
  const finishedAt = latestRun?.finishedAt || latestRun?.startedAt;
  return (
    <div className="space-y-5" data-testid="automation-detail-summary">
      <div className="flex items-center gap-3">
        <AgentAvatar iconId={agent?.iconId} className="h-10 w-10" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{agent?.name || t('ux.agentUnavailable')}</p>
          <p className="truncate text-xs text-muted-foreground">
            {workspaceName} · {t(`ux.chatMode.${job.deliverySessionMode}`)}
          </p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{triggerLabel}</p>
      <AutomationDisclosure title={t('ux.task')}>
        <MarkdownRenderer content={job.prompt} variant="muted" />
      </AutomationDisclosure>
      {latestRun ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">{t('ux.latestRun')}</h2>
            <Badge variant={latestRun.status === 'failed' ? 'destructive' : 'secondary'}>
              {latestStatus}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {finishedAt ? new Date(finishedAt).toLocaleString(locale) : t('noneYet')}
          </p>
          {latestRun.errorMessage ? (
            <p className="text-sm text-destructive">{latestRun.errorMessage}</p>
          ) : (
            <MarkdownRenderer
              content={latestRun.resultText || t('runDetails.noResult')}
              variant="muted"
              className="max-h-48 overflow-hidden"
            />
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenRun(latestRun.id)}>
            {t('runDetails.details')}
          </Button>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{t('runs.empty')}</p>
      )}
    </div>
  );
}
