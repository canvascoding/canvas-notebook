'use client';

import { useTranslations } from 'next-intl';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import { formatContextTokens, getContextStatusPresentation } from './contextStatusDisplay';

export function ContextMeasurementDetails({ status }: { status: RuntimeStatus | null }) {
  const t = useTranslations('chat');
  if (!status) return null;
  const { freshness, freshnessKey } = getContextStatusPresentation(status);
  const measuredAt = status.contextMeasurement?.measuredAt;
  const policy = status.compactionPolicy;
  const sourceLabel = (source: 'default' | 'persisted' | 'environment') => t(
    source === 'environment'
      ? 'contextCompactionSourceEnvironment'
      : source === 'persisted'
        ? 'contextCompactionSourcePersisted'
        : 'contextCompactionSourceDefault',
  );
  return (
    <div data-testid="context-measurement-details" className="space-y-1 text-[10px] leading-relaxed text-muted-foreground">
      <p>{t('contextMeasurementSource', {
        source: t(status.nextRequestEstimateSource === 'serialized_request' ? 'contextEstimateSerialized' : 'contextEstimateRough'),
      })}</p>
      {status.contextMeasurement?.scope === 'stored' ? <p>{t('contextStoredScope')}</p> : null}
      {measuredAt ? <p>{t('contextMeasuredAt', { time: new Date(measuredAt).toLocaleTimeString() })}</p> : null}
      {freshness !== 'current' ? (
        <p role="status">{t(freshnessKey)}</p>
      ) : null}
      {status.lastProviderInputTokens != null ? <p>{t('contextLastProviderInput', {
        tokens: formatContextTokens(status.lastProviderInputTokens),
      })}</p> : null}
      {policy ? (
        <div data-testid="context-compaction-policy-details" className="border-t border-border/70 pt-1">
          <p>{t('contextCompactionPolicyMode', {
            mode: t(policy.tailMode === 'lean' ? 'contextCompactionModeLean' : 'contextCompactionModeLegacy'),
          })}</p>
          <p>{t('contextCompactionPolicySummaryRoute', {
            route: t(policy.summaryRoute === 'configured'
              ? 'contextCompactionSummaryConfigured'
              : 'contextCompactionSummaryMain'),
          })}</p>
          {policy.activeSummaryModel ? <p className="break-all">{t('contextCompactionPolicySummaryModel', {
            identity: policy.activeSummaryModel,
          })}</p> : null}
          <p>{t('contextCompactionPolicySources', {
            tailMode: sourceLabel(policy.sources.tailMode),
            summaryModel: sourceLabel(policy.sources.summaryModel),
          })}</p>
          {policy.triggerTokens != null && policy.targetTokens != null ? <p>{t('contextCompactionPolicyBudget', {
            trigger: formatContextTokens(policy.triggerTokens),
            target: formatContextTokens(policy.targetTokens),
          })}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
