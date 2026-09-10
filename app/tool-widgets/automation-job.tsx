import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { readAutomationAppData, type AutomationAppData } from '../lib/tool-apps/automation-data';
import { WidgetField, WidgetShell } from './components';
import { createTranslator } from 'use-intl/core';
import { describeFriendlyScheduleLocalized } from '../lib/automations/schedule-presentation';
import type { AutomationWeekday } from '../lib/automations/types';

declare const __CANVAS_WIDGET_MESSAGES__: Record<'de' | 'en', { widget: Record<string, string>; automations: { scheduleSummary: Record<string, string>; intervalUnits: Record<string, string>; weekdays: Record<string, string> } }>;

function AutomationView() {
  const [job, setJob] = useState<AutomationAppData | null>(null);
  const [locale, setLocale] = useState('de');
  const [operation, setOperation] = useState('inspect_automation_job');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const app = new App({ name: 'Canvas Automation', version: '1.0.0' }, {}, { strict: true });
    const hostChanged = (context: McpUiHostContext) => {
      applyDocumentTheme(context.theme ?? 'light');
      if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
      if (context.locale) { document.documentElement.lang = context.locale; setLocale(context.locale); }
    };
    app.ontoolresult = (result) => setJob(readAutomationAppData(result.structuredContent));
    app.ontoolinput = ({ arguments: args }) => { if (typeof args?.operation === 'string') setOperation(args.operation); };
    app.onhostcontextchanged = hostChanged;
    void app.connect().then(() => hostChanged(app.getHostContext() ?? {})).catch(() => setFailed(true));
    return () => { void app.close(); };
  }, []);
  const messages = __CANVAS_WIDGET_MESSAGES__[locale.startsWith('de') ? 'de' : 'en'];
  const t = createTranslator({ locale, messages: messages.widget });
  const scheduleT = createTranslator({ locale, messages: messages.automations });
  const days: AutomationWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const weekdayLabels = Object.fromEntries(days.map((day) => [day, scheduleT(`weekdays.${day}`)])) as Record<AutomationWeekday, string>;
  if (!job) return <main className="widget-shell" role="status">{t(failed ? 'invalid' : 'loading')}</main>;
  const title = operation === 'create_automation_job' ? 'created' : operation === 'update_automation_job' ? 'updated' : 'inspected';
  return <WidgetShell title={t(title)} status={t(job.integrityStatus !== 'valid' ? 'quarantined' : job.status)}>
    <h1>{job.name}</h1>
    <p className="widget-schedule">{job.triggerKind === 'event' ? t('eventSchedule') : job.triggerKind === 'manual' ? t('manualSchedule')
      : describeFriendlyScheduleLocalized(job.schedule, (key, values) => scheduleT(key as Parameters<typeof scheduleT>[0], values), weekdayLabels)}</p>
    <dl><WidgetField label={t('timeZone')}>{job.schedule.timeZone}</WidgetField>
      <WidgetField label={t('nextRun')}>{job.nextRunAt
        ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: job.schedule.timeZone }).format(new Date(job.nextRunAt))
        : t('notScheduled')}</WidgetField></dl>
    <p className="widget-note">{t('currentState')}</p>
  </WidgetShell>;
}
createRoot(document.body.appendChild(document.createElement('div'))).render(<AutomationView />);
