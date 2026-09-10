import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { readAutomationAppData, type AutomationAppData } from '../lib/tool-apps/automation-data';
import { WidgetField, WidgetShell } from './components';

function AutomationView() {
  const [job, setJob] = useState<AutomationAppData | null>(null);
  const [locale, setLocale] = useState('de');
  useEffect(() => {
    const app = new App({ name: 'Canvas Automation', version: '1.0.0' }, {}, { strict: true });
    const hostChanged = (context: McpUiHostContext) => {
      applyDocumentTheme(context.theme ?? 'light');
      if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
      if (context.locale) { document.documentElement.lang = context.locale; setLocale(context.locale); }
    };
    app.ontoolresult = (result) => setJob(readAutomationAppData(result.structuredContent));
    app.onhostcontextchanged = hostChanged;
    void app.connect().then(() => hostChanged(app.getHostContext() ?? {}));
    return () => { void app.close(); };
  }, []);
  const de = locale.startsWith('de');
  if (!job) return <main className="widget-shell" role="status">{de ? 'Automation wird geladen …' : 'Loading automation …'}</main>;
  return <WidgetShell title="Automation" status={job.status === 'active' ? (de ? 'Aktiv' : 'Active') : (de ? 'Pausiert' : 'Paused')}>
    <h1>{job.name}</h1>
    <dl><WidgetField label={de ? 'Zeitzone' : 'Time zone'}>{job.schedule.timeZone}</WidgetField>
      <WidgetField label={de ? 'Nächster Lauf' : 'Next run'}>{job.nextRunAt
        ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: job.schedule.timeZone }).format(new Date(job.nextRunAt))
        : (de ? 'Nicht geplant' : 'Not scheduled')}</WidgetField></dl>
  </WidgetShell>;
}
createRoot(document.body.appendChild(document.createElement('div'))).render(<AutomationView />);
