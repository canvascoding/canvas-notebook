import { useEffect, useState } from 'react';
import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { createTranslator } from 'use-intl/core';

declare const __CANVAS_WIDGET_MESSAGES__: Record<'de' | 'en', { widget: Record<string, string> }>;

/** Internal resources share the same read-only SDK lifecycle. Actions live in the host. */
export function useWidget<Data>(name: string, readData: (value: unknown) => Data | null) {
  const [data, setData] = useState<Data | null>(null);
  const [locale, setLocale] = useState('de');
  const [operation, setOperation] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const app = new App({ name, version: '1.0.0' }, {}, { strict: true });
    const hostChanged = (context: McpUiHostContext) => {
      applyDocumentTheme(context.theme ?? 'light');
      if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
      if (context.locale) { document.documentElement.lang = context.locale; setLocale(context.locale); }
    };
    app.ontoolresult = (result) => { const next = readData(result.structuredContent); setData(next); setFailed(!next); };
    app.ontoolinput = ({ arguments: args }) => { if (typeof args?.operation === 'string') setOperation(args.operation); };
    app.onhostcontextchanged = hostChanged;
    void app.connect().then(() => hostChanged(app.getHostContext() ?? {})).catch(() => setFailed(true));
    return () => { void app.close(); };
  }, [name, readData]);
  const t = createTranslator({ locale, messages: __CANVAS_WIDGET_MESSAGES__[locale.startsWith('de') ? 'de' : 'en'].widget });
  return { data, locale, operation, failed, t };
}
