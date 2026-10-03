import 'server-only';

import type { TeamLicenseEmailKind } from '@/app/lib/license/team-license-email-outbox';
import { normalizeTimeZone } from '@/app/lib/time-zones';
import { normalizePublicOrigin } from '@/app/lib/utils/request-origin';
import { escapeHtml, renderAppEmailTemplate } from './base';

export type TeamLicenseEmailContext = {
  kind: TeamLicenseEmailKind;
  reason: string;
  seatLimit: number;
  recipientName?: string | null;
  ownerEmail?: string | null;
  occurredAt?: number;
  metadataJson?: string | null;
  appUrl?: string | null;
  timeZone?: string;
};

function eventMetadata(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function renderTeamLicenseNotificationEmail(
  input: TeamLicenseEmailContext,
  localeInput = 'en',
): { subject: string; html: string } {
  const locale = localeInput.toLowerCase().startsWith('de') ? 'de' : 'en';
  const copy = (de: string, en: string) => locale === 'de' ? de : en;
  const member = input.kind.startsWith('member_');
  const termWarning = input.kind.includes('_term_');
  const grace = input.kind === 'owner_grace' || input.kind === 'member_grace';
  const restored = input.kind === 'owner_restored' || input.kind === 'member_restored';
  const metadata = eventMetadata(input.metadataJson);
  const remaining = count(metadata.remainingFallbackUsers);
  const partial = !member && (input.kind === 'owner_mixed'
    || (restored && ((remaining ?? 0) > 0 || (count(metadata.suspendedMemberships) ?? 0) > 0)));
  const origin = normalizePublicOrigin(input.appUrl);
  const timeZone = normalizeTimeZone(input.timeZone);
  const date = (value: unknown): string | null => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return null;
    return `${new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-US', {
      dateStyle: 'medium', timeStyle: 'short', timeZone,
    }).format(parsed)} (${timeZone})`;
  };
  const settingsHref = origin ? `${origin}/${locale}/settings?tab=license#license-notifications` : null;
  const ownerEmail = input.ownerEmail?.trim();
  const contactHref = ownerEmail && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(ownerEmail)
    ? `mailto:${encodeURIComponent(ownerEmail)}` : null;
  let title: string;
  let intro: string;
  let impact: string;
  let nextStep: string;
  let actionLabel = copy('Team-Lizenz prüfen', 'Review team license');
  let actionHref = origin ? `${origin}/${locale}/settings?tab=license` : null;

  if (termWarning) {
    title = copy('Deine Team-Lizenz läuft bald ab', 'Your team license expires soon');
    intro = copy('Die befristete Team-Lizenz für diese Canvas-Notebook-Instanz nähert sich ihrem Laufzeitende.',
      'The fixed-term team license for this Canvas Notebook instance is nearing its end date.');
    impact = member
      ? copy('Dein Zugang ist derzeit verfügbar. Nach Ablauf kann er eingeschränkt werden. Deine Daten bleiben erhalten.',
        'Your access is currently available. Your access may be restricted after expiry. Your data will be retained.')
      : copy('Ohne Verlängerung kann der Zugang für Team-Mitglieder nach Ablauf eingeschränkt werden. Nutzer- und Workspace-Daten bleiben erhalten.',
        'Without renewal, team members may lose access after expiry. User and workspace data will be retained.');
    nextStep = member
      ? copy('Bitte wende dich an den Organisations-Owner, damit die Team-Lizenz rechtzeitig verlängert wird.',
        'Please contact the organization owner so the team license can be renewed in time.')
      : copy('Verlängere den Grant im Control Plane. Prüfe anschließend auf der Lizenzseite, ob die neue Laufzeit übernommen wurde.',
        'Renew the grant in Control Plane. Then check the license page to confirm the new term has been applied.');
  } else if (grace) {
    title = copy('Die Schonfrist deiner Team-Lizenz läuft', 'Your team license is in its grace period');
    intro = copy('Die Team-Lizenz ist abgelaufen. Bestehende Team-Zugänge bleiben während der Schonfrist vorübergehend aktiv.',
      'The team license has expired. Existing team access remains active temporarily during the grace period.');
    impact = copy('Nach Ende der Schonfrist können Team-Zugänge pausiert werden. Nutzer- und Workspace-Daten bleiben erhalten.',
      'Team access may be paused when the grace period ends. User and workspace data will be retained.');
    nextStep = member
      ? copy('Bitte wende dich vor Ablauf der Schonfrist an den Organisations-Owner.',
        'Please contact the organization owner before the grace period ends.')
      : copy('Verlängere den Grant im Control Plane und prüfe die Übernahme auf der Lizenzseite, bevor Mitglieder den Zugang verlieren.',
        'Renew the grant in Control Plane and confirm it on the license page before members lose access.');
  } else if (partial) {
    title = copy('Team-Zugänge teilweise wiederhergestellt', 'Team access partially restored');
    intro = copy('Ein Teil der Team-Zugänge wurde wiederhergestellt. Andere Konten sind weiterhin pausiert oder wurden durch das Platzlimit eingeschränkt.',
      'Some team access has been restored. Other accounts remain paused or have been restricted by the seat limit.');
    impact = copy('Wiederhergestellte Mitglieder können sich erneut anmelden. Für pausierte Konten bleiben die Daten erhalten.',
      'Restored members can sign in again. Data for paused accounts remains intact.');
    nextStep = copy('Prüfe in der Benutzerverwaltung, welche Konten aktiv sind. Gleiche das benötigte Platzkontingent mit der Team-Lizenz ab.',
      'Check which accounts are active in user management. Compare the seats you need with the team license.');
  } else if (restored) {
    title = member ? copy('Dein Team-Zugang ist wiederhergestellt', 'Your team access has been restored')
      : copy('Team-Zugänge sind wiederhergestellt', 'Team access has been restored');
    intro = member
      ? copy('Dein zuvor pausierter Zugang zu Canvas Notebook ist wieder aktiv.',
        'Your previously paused access to Canvas Notebook is active again.')
      : copy('Team-Zugänge wurden innerhalb des aktuellen Platzlimits wiederhergestellt.',
        'Team access has been restored within the current seat limit.');
    impact = member
      ? copy('Du kannst dich erneut anmelden. Deine Nutzer- und Workspace-Daten sind erhalten geblieben.',
        'You can sign in again. Your user and workspace data was retained.')
      : copy('Betroffene Mitglieder können sich erneut anmelden. Nutzer- und Workspace-Daten sind erhalten geblieben.',
        'Affected members can sign in again. User and workspace data was retained.');
    nextStep = member
      ? copy('Melde dich bei der unten genannten Instanz an, um weiterzuarbeiten.',
        'Sign in to the instance listed below to continue your work.')
      : copy('Prüfe die aktiven Konten in der Benutzerverwaltung. Diese Nachricht bestätigt die Wiederherstellung zum angegebenen Zeitpunkt.',
        'Review active accounts in user management. This message confirms restoration at the time shown below.');
  } else {
    title = member ? copy('Dein Team-Zugang ist pausiert', 'Your team access is paused')
      : copy('Team-Zugänge wurden eingeschränkt', 'Team access has been restricted');
    const reasons: Record<string, string> = {
      team_license_grace_expired: copy('Die Schonfrist der Team-Lizenz ist abgelaufen.', 'The team license grace period has ended.'),
      team_license_downgraded: copy('Die Lizenz wurde auf einen geringeren Funktionsumfang umgestellt.', 'The license was changed to a smaller feature set.'),
      team_license_inactive: copy('Für diese Instanz ist keine aktive Team-Lizenz verfügbar.', 'This instance has no active team license.'),
      team_reconciliation_restriction: copy('Der Abgleich mit Canvas hat das verfügbare Platzkontingent eingeschränkt.', 'Reconciliation with Canvas has restricted the available seats.'),
      team_license_active: copy('Der Team-Zugang wurde an das aktuelle Platzlimit angepasst.', 'Team access was adjusted to the current seat limit.'),
      team_license_offline_grace: copy('Der Team-Zugang wurde während der Lizenz-Schonfrist an das Platzlimit angepasst.', 'Team access was adjusted to the seat limit during the license grace period.'),
    };
    intro = Object.hasOwn(reasons, input.reason) ? reasons[input.reason]
      : copy('Die Team-Lizenz oder das verfügbare Platzkontingent hat sich geändert.',
        'The team license or available seat capacity has changed.');
    impact = member
      ? copy('Du kannst dich vorerst nicht anmelden. Deine Nutzer- und Workspace-Daten bleiben erhalten.',
        'You cannot sign in for now. Your user and workspace data remains intact.')
      : copy('Betroffene Mitglieder können sich vorerst nicht anmelden. Ihre Nutzer- und Workspace-Daten bleiben erhalten.',
        'Affected members cannot sign in for now. Their user and workspace data remains intact.');
    nextStep = member
      ? copy('Bitte wende dich an den Organisations-Owner. Er kann Lizenzstatus und verfügbare Plätze prüfen.',
        'Please contact the organization owner. They can review the license status and available seats.')
      : copy('Prüfe Lizenzstatus und Platzkontingent auf der Lizenzseite sowie die betroffenen Konten in der Benutzerverwaltung.',
        'Review the license status and seat capacity on the license page, and affected accounts in user management.');
  }

  if (!member && (restored || partial)) {
    actionLabel = copy('Team-Zugänge prüfen', 'Review team access');
    actionHref = origin ? `${origin}/${locale}/settings?tab=user-management` : null;
  } else if (member && restored) {
    actionLabel = copy('Bei Canvas Notebook anmelden', 'Sign in to Canvas Notebook');
    actionHref = origin ? `${origin}/${locale}/login` : null;
  } else if (member) {
    actionLabel = copy('Organisations-Owner kontaktieren', 'Contact organization owner');
    actionHref = contactHref;
  }

  const details: Array<[string, string]> = [];
  if (origin) details.push([copy('Instanz', 'Instance'), new URL(origin).host]);
  const occurredAt = date(input.occurredAt);
  if (occurredAt) details.push([copy('Meldung vom', 'Event time'), occurredAt]);
  if (count(input.seatLimit) !== null) {
    details.push([copy('Platzlimit', 'Seat limit'), String(input.seatLimit)]);
  }
  if (termWarning || grace) {
    const deadline = date(input.reason);
    details.push([grace ? copy('Schonfrist endet', 'Grace period ends') : copy('Lizenzlaufzeit endet', 'License term ends'),
      deadline ?? copy('Bitte auf der Lizenzseite prüfen', 'Please check the license page')]);
  }
  if (!member) {
    for (const [key, label] of [
      ['disabledUsers', copy('Pausierte Konten', 'Paused accounts')],
      ['restoredUsers', copy('Wiederhergestellte Konten', 'Restored accounts')],
      ['remainingFallbackUsers', copy('Weiterhin pausierte Konten', 'Accounts still paused')],
    ]) {
      const value = count(metadata[key]);
      if (value !== null) details.push([label, String(value)]);
    }
  } else if (contactHref && ownerEmail) {
    details.push([copy('Organisations-Owner', 'Organization owner'), ownerEmail]);
  }
  const name = input.recipientName?.trim();
  const greeting = name ? copy(`Hallo ${name},`, `Hello ${name},`) : undefined;
  const bodyHtml = `<p>${escapeHtml(intro)}</p><p>${escapeHtml(impact)}</p>
    <div class="panel">
      <p class="label">${escapeHtml(copy('Kontext zur Team-Lizenz', 'Team license context'))}</p>
      <table class="meta" role="presentation">${details.map(([label, value]) =>
    `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</table>
    </div>
    <p><strong>${escapeHtml(copy('Nächster Schritt', 'Next step'))}</strong><br>${escapeHtml(nextStep)}</p>`;
  const footerHtml = `${actionHref ? `<p class="muted">${escapeHtml(copy('Falls der Button nicht funktioniert:', 'If the button does not work:'))}<br>
      <a href="${escapeHtml(actionHref)}">${escapeHtml(actionHref)}</a></p>` : ''}
    ${escapeHtml(copy(
    'Automatische Lizenzmeldung für dein Team. Du hast Lizenz-E-Mails aktiviert. Die Angaben gelten zum oben genannten Zeitpunkt.',
    'Automatic license update for your team. You have license emails enabled. Details reflect the event time shown above.'))}
    ${settingsHref ? `<br><a href="${escapeHtml(settingsHref)}">${escapeHtml(copy('Lizenz-E-Mails verwalten', 'Manage license emails'))}</a>` : ''}`;
  const stage = input.kind.match(/_term_(14|3|1)d$/u)?.[1];
  const subject = stage
    ? copy(`Canvas Notebook: Team-Lizenz endet in höchstens ${stage} ${stage === '1' ? 'Tag' : 'Tagen'}`,
      `Canvas Notebook: Team license ends within ${stage} ${stage === '1' ? 'day' : 'days'}`)
    : `Canvas Notebook: ${title}`;
  return {
    subject,
    html: renderAppEmailTemplate({ locale, title, preheader: intro, intro: greeting, bodyHtml,
      action: actionHref ? { label: actionLabel, href: actionHref } : undefined, footerHtml }),
  };
}
