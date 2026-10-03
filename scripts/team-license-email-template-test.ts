import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

import type { SqlConnection } from '../app/lib/db';
import type { TeamLicenseEmailKind } from '../app/lib/license/team-license-email-outbox';
import type { TeamLicenseEmailContext, renderTeamLicenseNotificationEmail } from '../app/lib/email/templates/team-license-notification';

type Renderer = typeof renderTeamLicenseNotificationEmail;
type SentMail = {
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  messageId?: string;
};
type ManagedMessage = {
  purpose: string;
  to: string[];
  subject: string;
  body: string;
  isHtml: boolean;
  idempotencyKey: string;
};

const kinds: TeamLicenseEmailKind[] = [
  'owner_restricted', 'owner_restored', 'owner_mixed', 'member_paused', 'member_restored',
  'owner_term_14d', 'owner_term_3d', 'owner_term_1d',
  'member_term_14d', 'member_term_3d', 'member_term_1d', 'owner_grace', 'member_grace',
];
const occurredAt = Date.parse('2030-05-10T08:25:00.000Z');
const deadline = '2030-05-20T10:00:00.000Z';
const origin = 'https://notebook.example.test';
const ownerEmail = 'owner+license@example.test';
const counts = { disabledUsers: 7, restoredUsers: 3, remainingFallbackUsers: 11 };
const aggregateLabels = /Pausierte Konten|Wiederhergestellte Konten|Weiterhin pausierte Konten|Paused accounts|Restored accounts|Accounts still paused/u;

function fixture(kind: TeamLicenseEmailKind, overrides: Partial<TeamLicenseEmailContext> = {}): TeamLicenseEmailContext {
  return {
    kind, reason: kind.includes('_term_') || kind.endsWith('_grace') ? deadline : 'team_license_grace_expired',
    seatLimit: 5, recipientName: 'Alex Weber', ownerEmail, occurredAt,
    metadataJson: JSON.stringify(counts), appUrl: origin, timeZone: 'Europe/Berlin',
    ...overrides,
  };
}

function mainAction(html: string): string | null {
  return html.match(/<a class="button" href="([^"]+)">/u)?.[1] ?? null;
}

function verifyRendering(render: Renderer): void {
  for (const locale of ['de', 'en'] as const) {
    for (const kind of kinds) {
      const email = render(fixture(kind, { metadataJson: JSON.stringify({ ...counts, remainingFallbackUsers: 0 }) }), locale);
      assert.match(email.html, new RegExp(`<html lang="${locale}">`, 'u'), `${kind}: recipient language`);
      assert.match(email.html, /class="brand">Canvas Notebook/u, `${kind}: shared system email wrapper`);
      assert.match(email.html, /class="panel"/u, `${kind}: structured context`);
      assert.match(email.html, /notebook\.example\.test/u, `${kind}: identifiable instance`);
      assert.match(email.html, locale === 'de' ? /10:25 \(Europe\/Berlin\)/u : /10:25\s*AM \(Europe\/Berlin\)/u, `${kind}: event time in configured zone`);
      assert.match(email.html, locale === 'de' ? /Hallo Alex Weber,/u : /Hello Alex Weber,/u);
      assert.match(email.html, locale === 'de' ? /Nächster Schritt/u : /Next step/u);
      assert.match(email.html, locale === 'de' ? /Daten.*erhalten/u : /data.*retain|data.*intact/iu);
      assert.match(email.html, locale === 'de' ? /Meldung vom|Zeitpunkt der Meldung/u : /Event time/u);
      assert.match(email.html, locale === 'de' ? /Platzlimit/u : /Seat limit/u);
      assert.match(email.html, new RegExp(`href="${origin}/${locale}/settings\\?tab=license#license-notifications"`, 'u'));
      assert.doesNotMatch(email.html, /team_license_grace_expired|grantId|certificate/u, `${kind}: no raw internal diagnostics`);

      let expectedAction = `${origin}/${locale}/settings?tab=license`;
      if (kind === 'owner_restored' || kind === 'owner_mixed') expectedAction = `${origin}/${locale}/settings?tab=user-management`;
      else if (kind === 'member_restored') expectedAction = `${origin}/${locale}/login`;
      else if (kind.startsWith('member_')) expectedAction = `mailto:${encodeURIComponent(ownerEmail)}`;
      assert.equal(mainAction(email.html), expectedAction, `${kind}: role-appropriate action`);
      if (kind.startsWith('member_')) {
        assert.doesNotMatch(email.html, aggregateLabels, `${kind}: other members' counts remain private`);
      } else {
        assert.match(email.html, locale === 'de' ? /Pausierte Konten<\/td><td>7<\/td>/u : /Paused accounts<\/td><td>7<\/td>/u);
      }
      if (kind.includes('_term_') || kind.endsWith('_grace')) {
        assert.match(email.html, locale === 'de' ? /12:00 \(Europe\/Berlin\)/u : /12:00\s*PM \(Europe\/Berlin\)/u, `${kind}: deadline in configured zone`);
        assert.match(email.html, kind.endsWith('_grace')
          ? locale === 'de' ? /Schonfrist endet/u : /Grace period ends/u
          : locale === 'de' ? /Lizenzlaufzeit endet/u : /License term ends/u);
      }
      if (kind.includes('_term_')) {
        const stage = kind.match(/_(14|3|1)d$/u)?.[1];
        assert.match(email.subject, new RegExp(`${stage} ${locale === 'de' ? stage === '1' ? 'Tag' : 'Tagen' : stage === '1' ? 'day' : 'days'}$`, 'u'));
      }
    }
  }

  for (const kind of ['owner_mixed', 'owner_restored'] as const) {
    const partial = render(fixture(kind), 'en');
    assert.match(partial.subject, /partially restored/u);
    assert.match(partial.html, /Other accounts remain paused/u);
    assert.match(partial.html, /Accounts still paused<\/td><td>11<\/td>/u);
    assert.equal(mainAction(partial.html), `${origin}/en/settings?tab=user-management`);
  }
  const complete = render(fixture('owner_restored', { metadataJson: '{"remainingFallbackUsers":0}' }), 'en');
  assert.doesNotMatch(complete.subject, /partially/u);
  const membershipPartial = render(fixture('owner_restored', {
    metadataJson: '{"remainingFallbackUsers":0,"suspendedMemberships":2}',
  }), 'en');
  assert.match(membershipPartial.subject, /partially restored/u);
  assert.match(membershipPartial.html, /Other accounts remain paused/u);

  for (const metadataJson of [null, '{broken', '[]', 'null', '"unknown"', JSON.stringify({
    disabledUsers: '7', restoredUsers: -1, remainingFallbackUsers: 1.5,
  }), JSON.stringify({ disabledUsers: Number.MAX_SAFE_INTEGER + 1 })]) {
    const email = render(fixture('owner_restricted', { metadataJson }), 'en');
    assert.doesNotMatch(email.html, aggregateLabels, 'malformed or non-count metadata is omitted');
    assert.doesNotMatch(email.html, /broken|MAX_SAFE_INTEGER/u);
  }
  for (const reason of ['unknown-internal-reason', '<script>secret diagnostic</script>', 'toString', '__proto__']) {
    const email = render(fixture('member_paused', { reason }), 'en');
    assert.match(email.html, /The team license or available seat capacity has changed\./u);
    assert.doesNotMatch(email.html, /unknown-internal-reason|secret diagnostic|\[native code\]|\[object Object\]/u);
  }
  const malformed = render(fixture('owner_term_3d', {
    reason: 'NOT-A-DATE<script>private</script>', occurredAt: Number.NaN, seatLimit: Number.NaN,
  }), 'en');
  assert.match(malformed.html, /Please check the license page/u);
  assert.doesNotMatch(malformed.html, /NOT-A-DATE|private|Event time|Seat limit/u);

  const escaped = render(fixture('member_paused', {
    recipientName: 'Alex <img src=x onerror=alert(1)> & "Team"',
    appUrl: 'https://private:secret@notebook.example.test:8443/internal?token=secret#anything',
  }), 'en');
  assert.match(escaped.html, /Hello Alex &lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;Team&quot;,/u);
  assert.doesNotMatch(escaped.html, /<img|private:secret|token=secret|\/internal/u);
  assert.match(escaped.html, /https:\/\/notebook\.example\.test:8443\/en\/settings\?tab=license#license-notifications/u);
  for (const appUrl of [null, '', 'not a url', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'ftp://notebook.example.test']) {
    for (const kind of ['owner_restricted', 'owner_restored', 'member_restored'] as const) {
      const email = render(fixture(kind, { appUrl }), 'en');
      assert.equal(mainAction(email.html), null, 'missing/unsafe public URL never creates a broken app button');
      assert.doesNotMatch(email.html, /href="(?:https?:|javascript:|data:|ftp:)|localhost|#license-notifications/u);
    }
  }
  for (const invalidOwnerEmail of [null, '', 'not an address', '<owner@example.test>', 'owner@example.test\" onclick=\"alert(1)']) {
    const email = render(fixture('member_paused', { ownerEmail: invalidOwnerEmail }), 'en');
    assert.equal(mainAction(email.html), null, 'invalid contact never creates an unsafe mailto');
    assert.doesNotMatch(email.html, /mailto:|onclick=/u);
  }
  const noName = render(fixture('owner_restricted', { recipientName: '  ' }), 'en');
  assert.doesNotMatch(noName.html, /Hello\s*,/u);
  const newYork = render(fixture('owner_term_14d', { timeZone: 'America/New_York' }), 'en');
  assert.match(newYork.html, /4:25\s*AM \(America\/New_York\)/u);
  assert.match(newYork.html, /6:00\s*AM \(America\/New_York\)/u);
  const fallbackZone = render(fixture('owner_term_14d', { timeZone: 'invalid/time-zone' }), 'de');
  assert.match(fallbackZone.html, /10:25 \(Europe\/Berlin\)/u);
  assert.doesNotMatch(fallbackZone.html, /invalid\/time-zone/u);
}

async function seedAudit(database: SqlConnection, input: {
  id: string; organizationId: string; source?: string; status?: string; metadataJson?: string;
}): Promise<void> {
  await database.run(`
    INSERT INTO audit_events
      (id, organization_id, source, event_type, entity_type, action, status, metadata_json, created_at)
    VALUES ($1, $2, $3, 'team_license_access_changed', 'organization', 'team.owner_restored', $4, $5, $6)
  `, [input.id, input.organizationId, input.source ?? 'license', input.status ?? 'success',
    input.metadataJson ?? JSON.stringify(counts), occurredAt]);
}

async function verifyOutboxTransports(): Promise<void> {
  const { runPostgresMigrations } = await import('../app/lib/db/postgres');
  const { seedTeamSeatOrganization, teamSeatTestConnection } = await import('./team-seat-test-db');
  const { enqueueTeamLicenseEmail, processTeamLicenseEmailOutbox } = await import('../app/lib/license/team-license-email-outbox');
  const { updateUserPreferences } = await import('../app/lib/user-preferences');
  const { setServerPreferredTimeZone } = await import('../app/lib/server-settings');
  const { saveSystemSmtpConfiguration, setSystemEmailDeliveryMode } = await import('../app/lib/email/system-smtp-config');
  const { setSmtpTransportFactoryForTests } = await import('../app/lib/email/smtp-transport');
  const postgres = new PGlite();
  try {
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const database = teamSeatTestConnection(postgres);
    const organizationId = 'email-template-org-a';
    const otherOrganizationId = 'email-template-org-b';
    const ownerId = `owner-${organizationId}`;
    const memberId = 'email-template-member-a';
    await seedTeamSeatOrganization(database, organizationId, occurredAt);
    await seedTeamSeatOrganization(database, otherOrganizationId, occurredAt);
    await database.run(`INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, 'Member <A>', 'member-a@example.test', 1, 'user', $2, $2)`, [memberId, occurredAt]);
    await updateUserPreferences(ownerId, { locale: 'en', teamLicenseEmailNotificationsEnabled: true });
    await updateUserPreferences(memberId, { locale: 'de', teamLicenseEmailNotificationsEnabled: true });
    await setServerPreferredTimeZone(ownerId, 'Europe/Berlin');
    process.env.BASE_URL = 'https://email-instance.example.test/private?key=hidden';
    process.env.APP_BASE_URL = 'https://fallback.example.test';
    process.env.BETTER_AUTH_BASE_URL = 'https://auth-fallback.example.test';
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'false';

    const localMessages: SentMail[] = [];
    setSmtpTransportFactoryForTests((options) => ({
      sendMail: async (message: SentMail) => {
        localMessages.push(message);
        return { messageId: `local-captured-${localMessages.length}` };
      }, close: () => undefined, options,
    }) as never);
    await saveSystemSmtpConfiguration({
      host: 'smtp.example.test', port: 587, secure: false,
      username: 'notifications@example.test', password: 'isolated-test-password', fromAddress: 'notifications@example.test',
    });
    await seedAudit(database, { id: 'valid-audit-a', organizationId });
    await seedAudit(database, { id: 'other-audit-same-org', organizationId, metadataJson: '{"disabledUsers":707}' });
    await seedAudit(database, { id: 'foreign-audit', organizationId: otherOrganizationId, metadataJson: '{"disabledUsers":909}' });
    await seedAudit(database, { id: 'wrong-source-audit', organizationId, source: 'agent', metadataJson: '{"disabledUsers":808}' });
    await seedAudit(database, { id: 'failed-audit', organizationId, status: 'failed', metadataJson: '{"disabledUsers":606}' });
    await seedAudit(database, { id: 'malformed-audit', organizationId, metadataJson: '{not-json' });
    const auditCases = ['valid-audit-a', 'foreign-audit', 'wrong-source-audit', 'failed-audit', 'malformed-audit', 'missing-audit'];
    for (const [index, auditEventId] of auditCases.entries()) {
      const now = occurredAt + index * 60_000;
      await enqueueTeamLicenseEmail(database, {
        auditEventId, organizationId, userId: ownerId, kind: 'owner_restored',
        reason: 'team_license_active', seatLimit: 5, now,
      });
      assert.deepEqual(await processTeamLicenseEmailOutbox({ database, now }), { delivered: 1, failed: 0, skipped: 0, manualReview: 0 });
      const sent = localMessages.at(-1)!;
      assert.deepEqual(sent.to, [`${organizationId}@example.test`]);
      assert.equal(sent.text, undefined, 'local SMTP receives HTML MIME field');
      assert.match(sent.html!, /<!doctype html>[\s\S]*<html lang="en">/u);
      assert.match(sent.html!, /Hello Test Owner,/u);
      assert.doesNotMatch(sent.html!, /707|909|808|606|not-json|key=hidden|fallback\.example\.test/u);
      assert.equal(mainAction(sent.html!), 'https://email-instance.example.test/en/settings?tab=user-management');
      assert.equal(sent.messageId, `<${createHash('sha256').update(`team-license-email:${auditEventId}:${ownerId}`).digest('hex')}@example.test>`);
      if (auditEventId === 'valid-audit-a') {
        assert.match(sent.subject, /partially restored/u);
        assert.match(sent.html!, /Accounts still paused<\/td><td>11<\/td>/u);
      } else assert.doesNotMatch(sent.html!, aggregateLabels, 'only matching org/license/success audit supplies counts');
    }
    await enqueueTeamLicenseEmail(database, {
      auditEventId: 'valid-audit-a', organizationId, userId: memberId, kind: 'member_paused',
      reason: 'team_license_active', seatLimit: 5, now: occurredAt + 7 * 60_000,
    });
    assert.deepEqual(await processTeamLicenseEmailOutbox({ database, now: occurredAt + 7 * 60_000 }), {
      delivered: 1, failed: 0, skipped: 0, manualReview: 0,
    });
    const memberMail = localMessages.at(-1)!;
    assert.match(memberMail.html!, /<html lang="de">/u);
    assert.match(memberMail.html!, /Hallo Member &lt;A&gt;,/u);
    assert.equal(mainAction(memberMail.html!), `mailto:${encodeURIComponent(`${organizationId}@example.test`)}`);
    assert.doesNotMatch(memberMail.html!, new RegExp(otherOrganizationId, 'u'), 'contact belongs to the outbox organization');
    assert.doesNotMatch(memberMail.html!, aggregateLabels, 'member audit never exposes aggregate counts');

    setSmtpTransportFactoryForTests(() => { throw new Error('Managed email must not open an SMTP connection.'); });
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
    process.env.CANVAS_CONTROL_PLANE_URL = 'https://control.example.test';
    process.env.CANVAS_INSTANCE_TOKEN = 'isolated-test-instance-token';
    await setSystemEmailDeliveryMode('managed');
    await setServerPreferredTimeZone(ownerId, 'America/New_York');
    const managedMessages: ManagedMessage[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://control.example.test/v1/managed/system-email/status') {
        return new Response(JSON.stringify({ systemEmail: { available: true, fromAddress: 'notifications@example.test' } }), { status: 200 });
      }
      assert.equal(url, 'https://control.example.test/v1/managed/system-email/send', 'unexpected fetch fails without network');
      assert.equal(init?.method, 'POST');
      assert.equal(typeof init?.body, 'string');
      const sent = JSON.parse(init!.body as string) as ManagedMessage;
      managedMessages.push(sent);
      return managedMessages.length === 1
        ? new Response(JSON.stringify({ error: 'Definite isolated retry test.' }), { status: 502 })
        : new Response(JSON.stringify({ messageId: 'managed-captured' }), { status: 200 });
    };
    const managedAt = occurredAt + 8 * 60_000;
    await enqueueTeamLicenseEmail(database, {
      auditEventId: 'managed-term-audit', organizationId, userId: ownerId,
      kind: 'owner_term_14d', reason: deadline, seatLimit: 5, now: managedAt,
    });
    assert.deepEqual(await processTeamLicenseEmailOutbox({ database, now: managedAt }), {
      delivered: 0, failed: 1, skipped: 0, manualReview: 0,
    });
    assert.deepEqual(await processTeamLicenseEmailOutbox({ database, now: managedAt + 30_000 }), {
      delivered: 1, failed: 0, skipped: 0, manualReview: 0,
    });
    assert.equal(managedMessages.length, 2);
    assert.deepEqual(managedMessages[0], managedMessages[1], 'managed retry preserves full payload and idempotency key');
    assert.equal(managedMessages[0].isHtml, true);
    assert.equal(managedMessages[0].purpose, 'automation_alert');
    assert.deepEqual(managedMessages[0].to, [`${organizationId}@example.test`]);
    assert.equal(managedMessages[0].idempotencyKey, `team-license-email:managed-term-audit:${ownerId}`);
    assert.match(managedMessages[0].body, /<html lang="en">/u);
    assert.match(managedMessages[0].body, /6:00\s*AM \(America\/New_York\)/u);
    assert.equal(mainAction(managedMessages[0].body), 'https://email-instance.example.test/en/settings?tab=license');
    assert.deepEqual(await processTeamLicenseEmailOutbox({ database, now: managedAt + 60_000 }), {
      delivered: 0, failed: 0, skipped: 0, manualReview: 0,
    });
    assert.equal(managedMessages.length, 2, 'delivered job does not send again');
  } finally {
    setSmtpTransportFactoryForTests(null);
    await postgres.close();
  }
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-license-email-template-'));
  const envKeys = ['DATA', 'CANVAS_DATA_ROOT', 'INTEGRATIONS_ENV_PATH', 'BASE_URL', 'APP_BASE_URL',
    'BETTER_AUTH_BASE_URL', 'CANVAS_MANAGED_SERVICES_ENABLED', 'CANVAS_CONTROL_PLANE_URL', 'CANVAS_INSTANCE_TOKEN'] as const;
  const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  process.env.DATA = dataDir;
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.INTEGRATIONS_ENV_PATH = join(dataDir, 'secrets', 'Canvas-Integrations.env');
  globalThis.fetch = async () => { throw new Error('Network is disabled for license email template tests.'); };
  try {
    const { renderTeamLicenseNotificationEmail: render } = await import('../app/lib/email/templates/team-license-notification');
    verifyRendering(render);
    await verifyOutboxTransports();
    console.info('Team license email templates passed all 13 kinds in DE/EN, safe context, role privacy, scoped audit data, and HTML SMTP/Managed delivery.');
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
