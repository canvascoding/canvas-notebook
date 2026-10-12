import 'server-only';

import { escapeHtml, renderAppEmailTemplate } from './base';

export function renderTeamInvitationEmail(input: {
  recipientName: string | null;
  acceptanceUrl: string;
  expiresAt: number;
  locale?: string;
}): { subject: string; html: string } {
  const locale = input.locale?.toLowerCase().startsWith('de') ? 'de' : 'en';
  const copy = (de: string, en: string) => locale === 'de' ? de : en;
  const subject = copy('Deine Einladung zu Canvas Notebook', 'Your invitation to Canvas Notebook');
  const expiry = new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(new Date(input.expiresAt));
  const greeting = input.recipientName
    ? copy(`Hallo ${input.recipientName},`, `Hello ${input.recipientName},`)
    : copy('Hallo,', 'Hello,');
  return {
    subject,
    html: renderAppEmailTemplate({
      locale,
      title: subject,
      intro: copy('Du wurdest eingeladen, Canvas Notebook mit deinem Team zu nutzen.',
        'You have been invited to use Canvas Notebook with your team.'),
      bodyHtml: `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(copy(
        'Öffne deine Einladung und richte dein eigenes Passwort ein. Danach kannst du dein persönliches Onboarding abschließen.',
        'Open your invitation and set your own password. You can then complete your personal onboarding.',
      ))}</p><p>${escapeHtml(copy(`Der Link ist bis ${expiry} (UTC) gültig.`, `This link is valid until ${expiry} (UTC).`))}</p><p>${escapeHtml(copy(
        'Diese Einladung ist persönlich. Bitte gib den Link nicht weiter. Wenn du keine Einladung erwartest, kannst du diese E-Mail ignorieren.',
        'This invitation is personal. Please do not share the link. If you were not expecting an invitation, you can ignore this email.',
      ))}</p>`,
      action: { label: copy('Einladung öffnen', 'Open invitation'), href: input.acceptanceUrl },
    }),
  };
}
