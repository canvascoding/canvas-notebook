'use client';

import { useTranslations } from 'next-intl';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import { formatContextTokens, getContextStatusPresentation } from './contextStatusDisplay';

export function ContextMeasurementDetails({ status }: { status: RuntimeStatus | null }) {
  const t = useTranslations('chat');
  if (!status) return null;
  const { freshness, freshnessKey } = getContextStatusPresentation(status);
  const measuredAt = status.contextMeasurement?.measuredAt;
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
    </div>
  );
}
