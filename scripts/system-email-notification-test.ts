import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Module from 'node:module';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-system-email-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.INTEGRATIONS_ENV_PATH = path.join(dataDir, 'secrets', 'Canvas-Integrations.env');

type SentMail = {
  from: unknown;
  to: unknown;
  replyTo: unknown;
  subject: string;
  html?: string;
  text?: string;
};

const sentMessages: SentMail[] = [];
let verified = 0;

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;

moduleInternals._load = (request, parent, isMain) => {
  if (request === '@/app/lib/email/service' || request.endsWith('/email/service')) {
    return {
      listEmailAccounts: async () => ({ mode: 'local', accounts: [] }),
      sendEmailMessage: async () => {
        throw new Error('Personal mail fallback should not be used while system SMTP is configured.');
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const {
    clearSystemSmtpConfiguration,
    getSystemSmtpConfigurationStatus,
    saveSystemSmtpConfiguration,
  } = await import('../app/lib/email/system-smtp-config');
  const { resolveNotificationDeliveryRoute, sendNotificationThroughRoute } = await import('../app/lib/email/notification-delivery-service');
  const { setSmtpTransportFactoryForTests } = await import('../app/lib/email/smtp-transport');
  const { sendSystemSmtpEmail, verifySystemSmtpConnection } = await import('../app/lib/email/system-smtp-service');

  await clearSystemSmtpConfiguration();
  assert.equal((await getSystemSmtpConfigurationStatus()).configured, false);

  setSmtpTransportFactoryForTests((options) => ({
    verify: async () => {
      verified += 1;
    },
    sendMail: async (message: SentMail) => {
      sentMessages.push(message);
      return { messageId: '<system-notification@example.test>' };
    },
    close: () => undefined,
    options,
  }) as never);

  const status = await saveSystemSmtpConfiguration({
    host: 'smtp.example.test',
    port: '587',
    secure: false,
    username: 'notifications@example.test',
    password: 'test-password',
    fromAddress: 'notifications@example.test',
    fromName: 'Canvas Notifications',
    replyTo: 'support@example.test',
  });

  assert.equal(status.configured, true);
  assert.equal(status.passwordConfigured, true);
  assert.equal(status.host, 'smtp.example.test');
  assert.equal(status.fromAddress, 'notifications@example.test');

  const route = await resolveNotificationDeliveryRoute('recipient-without-mailbox', 'recipient@example.test');
  assert.deepEqual(route, { kind: 'system_smtp' });

  const verifiedConnection = await verifySystemSmtpConnection();
  assert.equal(verified, 1);
  assert.deepEqual(verifiedConnection, { host: 'smtp.example.test', port: 587, secure: false });

  const directResult = await sendSystemSmtpEmail({
    to: ['recipient@example.test'],
    subject: 'Direct system notification',
    body: '<strong>Hello</strong>',
    isHtml: true,
  });
  assert.equal(directResult.messageId, '<system-notification@example.test>');
  assert.equal(sentMessages[0]?.from instanceof Object, true);
  assert.deepEqual(sentMessages[0]?.to, ['recipient@example.test']);
  assert.equal(sentMessages[0]?.replyTo, 'support@example.test');
  assert.equal(sentMessages[0]?.html, '<strong>Hello</strong>');

  const routedResult = await sendNotificationThroughRoute(route, 'recipient-without-mailbox', {
    to: ['recipient@example.test'],
    subject: 'Routed system notification',
    body: '<p>Routed</p>',
    isHtml: true,
  });
  assert.equal(routedResult.messageId, '<system-notification@example.test>');
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[1]?.subject, 'Routed system notification');

  const unchangedPasswordStatus = await saveSystemSmtpConfiguration({
    host: 'smtp.example.test',
    port: 465,
    secure: true,
    username: 'notifications@example.test',
    password: '',
    fromAddress: 'notifications@example.test',
  });
  assert.equal(unchangedPasswordStatus.configured, true);
  assert.equal(unchangedPasswordStatus.port, 465);
  assert.equal(unchangedPasswordStatus.secure, true);

  await clearSystemSmtpConfiguration();
  assert.equal((await getSystemSmtpConfigurationStatus()).configured, false);
  setSmtpTransportFactoryForTests(null);
  console.log('System email notification test passed.');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
