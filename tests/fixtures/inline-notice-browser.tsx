import React from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TeamModeHostedOnlyNotice } from '@/app/components/team/TeamModeHostedOnlyNotice';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { createWorkspaceAppearanceCssTokens } from '@/app/lib/workspaces/appearance-theme';
import messagesDe from '@/messages/de.json';
import messagesEn from '@/messages/en.json';

function NoticeExamples() {
  return <main className="mx-auto max-w-5xl space-y-4 p-4">
    <InlineNotice data-testid="setup-notice" variant="warning" title="Gemini-Zugang einrichten" actions={<Button asChild variant="outline" size="sm"><a href="#credentials">Zugangsdaten für diesen Provider einrichten</a></Button>}>
      <p>Für die gewählte Generierung ist noch kein Gemini-Zugang eingerichtet.</p>
      <details><summary className="cursor-pointer text-foreground">Details</summary><p>GEMINI_API_KEY wird zentral oder im persönlichen Secrets-Bereich verwaltet.</p></details>
    </InlineNotice>
    <InlineNotice data-testid="info-notice" variant="info" size="compact">Die Verbindung wird geprüft.</InlineNotice>
    <InlineNotice data-testid="success-notice" variant="success" title="Gespeichert">Die Zugangsdaten wurden gespeichert.</InlineNotice>
    <InlineNotice data-testid="error-notice" variant="destructive" title="Prüfung fehlgeschlagen" actions={<Button variant="outline" size="sm">Erneut versuchen</Button>}>
      <p>Die Konfiguration konnte nicht geladen werden.</p>
      <code>{'a'.repeat(180)}</code>
    </InlineNotice>
    <InlineNotice data-testid="group-notice" variant="warning" role="group">Installation<InlineNotice variant="destructive" size="compact">Installation fehlgeschlagen.</InlineNotice></InlineNotice>
    <div className="grid grid-cols-1 gap-4">
      {(['de', 'en'] as const).map((locale) => (['compact', 'normal'] as const).map((layout) => (
        <section key={`${locale}-${layout}`} data-testid={`hosted-${locale}-${layout}`} className="w-72 max-w-full">
          <NextIntlClientProvider locale={locale} timeZone="UTC" messages={{
            teamModeHostedOnly: (locale === 'de' ? messagesDe : messagesEn).teamModeHostedOnly,
          }}>
            <TeamModeHostedOnlyNotice compact={layout === 'compact'} />
          </NextIntlClientProvider>
        </section>
      )))}
    </div>
  </main>;
}

declare global {
  interface Window {
    applyNoticeTheme: (mode: 'light' | 'dark', custom: boolean, radius: number, backgroundColor?: string) => void;
  }
}

window.applyNoticeTheme = (mode, custom, radius, backgroundColor) => {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  const tokens = createWorkspaceAppearanceCssTokens({
    enabled: true, radiusPx: radius, backgroundColor: backgroundColor ?? (custom ? '#fbf8f1' : '#f7f9fc'),
    textColor: '#29251f', accentColor: custom ? '#b24a2b' : '#1e4f78', font: 'canvas-sans',
  }, mode);
  for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value);
};

createRoot(document.getElementById('root')!).render(<NoticeExamples />);
