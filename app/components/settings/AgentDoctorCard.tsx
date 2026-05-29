'use client';

import { Loader2, Stethoscope } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { AgentSettingsAccordionCard } from './AgentSettingsAccordionCard';

export type AgentConfigReadiness = {
  activeProviderId: string;
  activeProviderReady: boolean;
  pi?: {
    activeProvider: string;
    model: string;
    ready: boolean;
    authSet: boolean;
    issues: string[];
  };
};

export type DoctorResult = {
  checkedAt: string;
  summary: {
    ready: boolean;
    errors: number;
    warnings: number;
  };
  readiness: AgentConfigReadiness;
  promptDiagnostics: {
    loadedFiles: string[];
    includedFiles: string[];
    emptyFiles: string[];
    usedFallback: boolean;
    fallbackReason: 'all-empty' | 'read-failed' | null;
  };
  qmd: {
    enabled: boolean;
    ready: boolean;
    binaryAvailable: boolean;
    defaultMode: 'search' | 'vsearch' | 'query';
    allowExpensiveQueryMode: boolean;
    collections: Array<{
      name: string;
      sourceType: 'workspace-text' | 'workspace-derived';
      path: string;
      present: boolean;
    }>;
    lastUpdateAt: string | null;
    lastUpdateSuccess: boolean;
    lastEmbedAt: string | null;
    derivedDocxIndexing: {
      enabled: boolean;
      healthy: boolean;
      lastRunAt: string | null;
      extractedCount: number;
      updatedCount: number;
      errorCount: number;
      warningCount: number;
    };
    issues: string[];
  };
};

type AgentDoctorCardProps = {
  doctorResult: DoctorResult | null;
  doctorRunning: boolean;
  doctorError: string | null;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onRunDoctor: () => void;
};

export function AgentDoctorCard({
  doctorResult,
  doctorRunning,
  doctorError,
  isOpen,
  onOpenChange,
  onRunDoctor,
}: AgentDoctorCardProps) {
  const locale = useLocale();
  const t = useTranslations('settings');
  const doctorStatus = doctorRunning
    ? t('agentPanel.doctor.runningSummary')
    : doctorResult
      ? doctorResult.summary.ready
        ? t('agentPanel.doctor.ready')
        : t('agentPanel.doctor.issuesDetected')
      : t('agentPanel.doctor.notRunSummary');
  const summaryItems = [
    doctorStatus,
    doctorResult
      ? t('agentPanel.doctor.issueSummary', {
          errors: doctorResult.summary.errors,
          warnings: doctorResult.summary.warnings,
        })
      : null,
    doctorError ? t('agentPanel.doctor.errorSummary') : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <AgentSettingsAccordionCard
      title={t('agentPanel.doctor.title')}
      description={t('agentPanel.doctor.description')}
      icon={Stethoscope}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      summaryItems={summaryItems}
    >
      <Button onClick={onRunDoctor} disabled={doctorRunning}>
        {doctorRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Stethoscope className="mr-2 h-4 w-4" />}
        {t('agentPanel.doctor.run')}
      </Button>

      {doctorError && <p className="text-sm text-destructive">{doctorError}</p>}

      {doctorResult && (
        <div className="rounded border border-border bg-muted/40 p-3 text-sm">
          <p>
            {t('agentPanel.doctor.statusLabel')}{' '}
            <span className={doctorResult.summary.ready ? 'text-primary' : 'text-destructive'}>
              {doctorResult.summary.ready ? t('agentPanel.doctor.ready') : t('agentPanel.doctor.issuesDetected')}
            </span>
          </p>
          <p>{t('agentPanel.doctor.errorsLabel')} {doctorResult.summary.errors}</p>
          <p>{t('agentPanel.doctor.warningsLabel')} {doctorResult.summary.warnings}</p>
          <p>{t('agentPanel.doctor.checkedLabel')} {new Date(doctorResult.checkedAt).toLocaleString(locale)}</p>
          <p>{t('agentPanel.doctor.promptFilesLoaded')} {doctorResult.promptDiagnostics.loadedFiles.join(', ') || t('agentPanel.doctor.none')}</p>
          <p>{t('agentPanel.doctor.promptFilesIncluded')} {doctorResult.promptDiagnostics.includedFiles.join(', ') || t('agentPanel.doctor.none')}</p>
          <p>{t('agentPanel.doctor.promptFilesEmpty')} {doctorResult.promptDiagnostics.emptyFiles.join(', ') || t('agentPanel.doctor.none')}</p>
          <p>
            {t('agentPanel.doctor.promptFallback')}{' '}
            <span className={doctorResult.promptDiagnostics.usedFallback ? 'text-destructive font-medium' : 'text-primary'}>
              {doctorResult.promptDiagnostics.usedFallback
                ? t('agentPanel.doctor.promptFallbackActive', {
                    reason: doctorResult.promptDiagnostics.fallbackReason || t('agentPanel.doctor.unknown'),
                  })
                : t('agentPanel.doctor.promptFallbackInactive')}
            </span>
          </p>
          <div className="mt-3 rounded border border-border/70 bg-background/70 p-3">
            <p>
              {t('agentPanel.doctor.qmdLabel')}{' '}
              <span className={
                !doctorResult.qmd.enabled
                  ? 'text-muted-foreground font-medium'
                  : doctorResult.qmd.ready
                    ? 'text-primary font-medium'
                    : 'text-destructive font-medium'
              }>
                {!doctorResult.qmd.enabled
                  ? t('agentPanel.doctor.disabledStatus')
                  : doctorResult.qmd.ready
                    ? t('agentPanel.doctor.ready')
                    : t('agentPanel.doctor.needsAttention')}
              </span>
            </p>
            {doctorResult.qmd.enabled && (
              <>
                <p>{t('agentPanel.doctor.qmdBinary')} {doctorResult.qmd.binaryAvailable ? t('agentPanel.doctor.available') : t('agentPanel.doctor.missing')}</p>
                <p>{t('agentPanel.doctor.defaultMode')} {doctorResult.qmd.defaultMode}</p>
                <p>{t('agentPanel.doctor.expensiveQueryMode')} {doctorResult.qmd.allowExpensiveQueryMode ? t('agentPanel.doctor.enabled') : t('agentPanel.doctor.disabled')}</p>
                <p>{t('agentPanel.doctor.collections')} {doctorResult.qmd.collections.map((collection) => collection.name).join(', ') || t('agentPanel.doctor.none')}</p>
                <p>{t('agentPanel.doctor.lastQmdUpdate')} {doctorResult.qmd.lastUpdateAt ? new Date(doctorResult.qmd.lastUpdateAt).toLocaleString(locale) : t('agentPanel.doctor.noSuccessfulUpdateYet')}</p>
                <p>{t('agentPanel.doctor.lastQmdEmbed')} {doctorResult.qmd.lastEmbedAt ? new Date(doctorResult.qmd.lastEmbedAt).toLocaleString(locale) : t('agentPanel.doctor.notRecordedYet')}</p>
                <p>
                  {t('agentPanel.doctor.derivedDocxIndexing')}{' '}
                  <span className={doctorResult.qmd.derivedDocxIndexing.enabled && doctorResult.qmd.derivedDocxIndexing.healthy ? 'text-primary font-medium' : 'text-destructive font-medium'}>
                    {doctorResult.qmd.derivedDocxIndexing.enabled
                      ? doctorResult.qmd.derivedDocxIndexing.healthy
                        ? t('agentPanel.doctor.healthy')
                        : t('agentPanel.doctor.withIssues')
                      : t('agentPanel.doctor.disabled')}
                  </span>
                </p>
                <p>{t('agentPanel.doctor.derivedLastRun')} {doctorResult.qmd.derivedDocxIndexing.lastRunAt ? new Date(doctorResult.qmd.derivedDocxIndexing.lastRunAt).toLocaleString(locale) : t('agentPanel.doctor.notRunYet')}</p>
                <p>{t('agentPanel.doctor.derivedFiles')} {doctorResult.qmd.derivedDocxIndexing.extractedCount}</p>
                <p>{t('agentPanel.doctor.derivedUpdates')} {doctorResult.qmd.derivedDocxIndexing.updatedCount}</p>
                <p>{t('agentPanel.doctor.derivedWarnings')} {doctorResult.qmd.derivedDocxIndexing.warningCount}</p>
                <p>{t('agentPanel.doctor.derivedErrors')} {doctorResult.qmd.derivedDocxIndexing.errorCount}</p>
              </>
            )}
          </div>
          {doctorResult.readiness.pi?.issues.map((issue, idx) => (
            <p key={idx} className="mt-1 font-medium text-destructive">• {issue}</p>
          ))}
          {doctorResult.qmd.enabled && doctorResult.qmd.issues.map((issue, idx) => (
            <p key={`qmd-${idx}`} className="mt-1 font-medium text-destructive">• {issue}</p>
          ))}
        </div>
      )}
    </AgentSettingsAccordionCard>
  );
}
