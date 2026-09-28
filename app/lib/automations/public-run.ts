import type { AutomationRunRecord } from './types';

/** Keep retry pins server-side; public provenance contains only redacted source diagnostics. */
export function projectAutomationRunForApi(run: AutomationRunRecord): AutomationRunRecord {
  if (!run.metadataJson) return run;
  const metadata = { ...run.metadataJson };
  delete metadata.automationSources;
  delete metadata.automationContinuity;
  const context = metadata.automationContext;
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    const record = context as Record<string, unknown>;
    metadata.automationContext = {
      ...record,
      ...(Array.isArray(record.sources) ? { sources: record.sources.map((source) => {
        if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
        return { ...source, sourceRunId: null };
      }) } : {}),
    };
  }
  return { ...run, metadataJson: metadata };
}
