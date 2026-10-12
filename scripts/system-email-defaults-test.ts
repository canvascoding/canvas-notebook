import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-system-email-defaults-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.INTEGRATIONS_ENV_PATH = path.join(dataDir, 'secrets', 'Canvas-Integrations.env');
delete process.env.CANVAS_MANAGED_SERVICES_ENABLED;
delete process.env.CANVAS_INSTANCE_TOKEN;

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === '@/app/lib/email/service' || request.endsWith('/email/service')) {
    return { listEmailAccounts: async () => { throw new Error('Unexpected personal mailbox fallback'); } };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { mutateScopedEnvEntries, readScopedEnvState } = await import('../app/lib/integrations/env-config');
  const { SYSTEM_SMTP_KEYS, getSystemSmtpConfigurationStatus, saveSystemSmtpConfiguration, setSystemEmailDeliveryMode, clearSystemSmtpConfiguration } = await import('../app/lib/email/system-smtp-config');
  const { resolveNotificationDeliveryRoute } = await import('../app/lib/email/notification-delivery-service');
  const originalFetch = globalThis.fetch;
  let availabilityRequests = 0;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://control.example.test/v1/managed/system-email/status');
    availabilityRequests++;
    return Response.json({ systemEmail: { available: true, fromAddress: 'notifications@example.test' } });
  };
  try {
    assert.equal((await getSystemSmtpConfigurationStatus()).deliveryMode, 'local');
    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
    process.env.CANVAS_CONTROL_PLANE_URL = 'https://control.example.test';
    assert.equal((await getSystemSmtpConfigurationStatus()).managedAvailable, false, 'A URL alone is not a managed connection');
    process.env.CANVAS_INSTANCE_TOKEN = 'isolated-test-token';
    assert.equal((await getSystemSmtpConfigurationStatus()).deliveryMode, 'managed');

    await mutateScopedEnvEntries('integrations', entries => [...entries, { key: SYSTEM_SMTP_KEYS.host, value: 'legacy.example.test' }]);
    const incomplete = await getSystemSmtpConfigurationStatus();
    assert(incomplete.configurationError);
    assert.equal(incomplete.deliveryMode, 'managed', 'Legacy SMTP fields do not suppress the connected installation default');
    assert.deepEqual(await resolveNotificationDeliveryRoute('isolated-user', 'recipient@example.test'), { kind: 'managed_system_email' });
    assert.equal(availabilityRequests, 1);

    await saveSystemSmtpConfiguration({ host: 'smtp.example.test', port: 587, secure: false, username: 'sender', password: 'isolated-test-password', fromAddress: 'sender@example.test' });
    assert.equal((await getSystemSmtpConfigurationStatus()).deliveryMode, 'local', 'Saving SMTP is an explicit local choice');
    assert.deepEqual(await resolveNotificationDeliveryRoute('isolated-user', 'recipient@example.test'), { kind: 'system_smtp' });
    const secrets = (await readScopedEnvState('integrations')).entries.filter(entry => entry.key !== SYSTEM_SMTP_KEYS.deliveryMode);
    await mutateScopedEnvEntries('integrations', entries => entries.filter(entry => entry.key !== SYSTEM_SMTP_KEYS.deliveryMode));
    assert.equal((await getSystemSmtpConfigurationStatus()).deliveryMode, 'managed', 'The managed default also applies to complete legacy SMTP with no saved mode');
    assert.deepEqual((await readScopedEnvState('integrations')).entries, secrets, 'Resolving the default does not rewrite secrets');

    await setSystemEmailDeliveryMode('disabled');
    assert.equal((await getSystemSmtpConfigurationStatus()).deliveryMode, 'disabled');
    assert.equal((await resolveNotificationDeliveryRoute('isolated-user', 'recipient@example.test')).kind, 'unavailable');
    delete process.env.CANVAS_INSTANCE_TOKEN;
    assert.equal((await getSystemSmtpConfigurationStatus()).deliveryMode, 'disabled');
    await setSystemEmailDeliveryMode('local');
    process.env.CANVAS_INSTANCE_TOKEN = 'isolated-test-token';
    assert.equal((await getSystemSmtpConfigurationStatus()).deliveryMode, 'local', 'Reconnecting preserves an explicit local choice');
    await setSystemEmailDeliveryMode('managed');
    delete process.env.CANVAS_INSTANCE_TOKEN;
    assert.equal((await getSystemSmtpConfigurationStatus()).deliveryMode, 'managed');
    assert.deepEqual(await resolveNotificationDeliveryRoute('isolated-user', 'recipient@example.test'), { kind: 'unavailable', reason: 'Managed system email is unavailable.' });
    assert.equal(availabilityRequests, 1, 'A lost connection does not switch to another sender or issue a request');
    process.env.CANVAS_INSTANCE_TOKEN = 'isolated-test-token';
    await clearSystemSmtpConfiguration();
    assert.equal((await getSystemSmtpConfigurationStatus()).deliveryMode, 'disabled', 'Removing SMTP remains an explicit disable');
    console.log('System email installation defaults and delivery routing passed.');
  } finally { globalThis.fetch = originalFetch; }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  internals._load = originalLoad;
  rmSync(dataDir, { recursive: true, force: true });
});
