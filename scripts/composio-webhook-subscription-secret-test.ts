import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const moduleInternals = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
const originalLoad = moduleInternals._load;
const environmentBefore = { ...process.env };
const originalFetch = globalThis.fetch;
const encryptedReferences: string[] = [];
let encryptCalls = 0;
let insertedValues: Record<string, unknown> | null = null;
let upsertValues: Record<string, unknown> | null = null;

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-composio-webhook-gateway-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_SECRETS_MASTER_KEY = 'fixture-canvas-store-master-key';
  process.env.INTEGRATIONS_ENV_MASTER_KEY = 'fixture-integrations-master-key';
  process.env.COMPOSIO_API_KEY = 'fixture-composio-api-key';
  delete process.env.CANVAS_SECRETS_ENV_PATH;
  process.env.BASE_URL = 'https://canvas.example.test';
  try {
    const secrets = await import('../app/lib/composio/composio-webhook-secret');
    const envStore = await import('../app/lib/secrets/unified-env-store');
    const table = { name: 'composioWebhookSubscriptions' };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [] }),
          }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedValues = values;
          return {
            onConflictDoUpdate: (input: { set: Record<string, unknown> }) => {
              upsertValues = input.set;
              return { returning: async () => [values] };
            },
          };
        },
      }),
    };

    moduleInternals._load = function load(request, parent, isMain) {
      if (request === 'server-only') return {};
      if (request === 'drizzle-orm') return { eq: () => ({}), desc: () => ({}) };
      if (request === './composio-client') return {
        getComposio: async () => null,
        getComposioMode: async () => 'local',
        getLocalComposioApiKey: async () => 'fixture-composio-api-key',
        isManagedComposioConfigured: () => false,
        verifyApiKey: async () => true,
      };
      if (request === './composio-auth') return { disconnectTool: async () => undefined, getActiveConnectedAccounts: async () => [], getConnectedAccounts: async () => [], initiateConnection: async () => undefined };
      if (request === './composio-session') return { resetSessionCache: () => undefined };
      if (request === './composio-toolkit-registry') return { clearToolkitCache: () => undefined, getAvailableToolkits: async () => [] };
      if (request === './composio-tool-discovery') return { inferConnectedComposioToolkits: () => [], normalizeComposioToolkits: () => [], selectComposioToolSearchResults: () => [] };
      if (request === './composio-oauth-state') return { createComposioOAuthFlowState: async () => ({}) };
      if (request === './managed-composio-client') return { requestManagedComposio: async () => ({}) };
      if (request === './composio-provider-error') return { classifyComposioFailure: (input: unknown) => input, ComposioProviderError: class extends Error {} };
      if (request === './managed-composio-execution') return { executeManagedComposioTool: async () => ({}) };
      if (request === './composio-webhook-secret' && parent?.filename?.endsWith('/composio-gateway.ts')) return {
        encryptWebhookSecret: async (secret: string) => {
          encryptCalls += 1;
          const reference = await secrets.encryptWebhookSecret(secret);
          encryptedReferences.push(reference);
          return reference;
        },
        previewWebhookSecret: secrets.previewWebhookSecret,
      };
      if (request === '../db') return { db };
      if (request === '../db/schema') return { composioWebhookSubscriptions: table };
      return originalLoad.call(this, request, parent, isMain);
    };

    globalThis.fetch = async () => new Response(JSON.stringify({
      id: 'subscription-fixture-id',
      secret: 'gateway-webhook-secret-fixture',
      webhook_url: 'https://canvas.example.test/api/composio/webhook',
      enabled_events: ['composio.trigger.success'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const { ensureLocalWebhookSubscription } = await import('../app/lib/composio/composio-gateway');
    const result = await ensureLocalWebhookSubscription({ context: { storageScope: { secretScope: 'system' } } as never });
    assert.equal(encryptCalls, 1, 'gateway encrypts a webhook secret only once');
    assert.equal(encryptedReferences.length, 1);
    const reference = encryptedReferences[0];
    assert.match(reference, /^canvas:env:v1:CANVAS_CREDENTIAL_COMPOSIO_WEBHOOK_[a-f0-9]{64}$/u);
    assert.equal(insertedValues?.encryptedSecret, reference);
    assert.equal(upsertValues?.encryptedSecret, reference, 'insert and conflict update reuse the same canonical reference');
    assert.equal(result.encryptedSecret, reference);

    const key = reference.slice('canvas:env:v1:'.length);
    const record = envStore.readUnifiedSecretValue(key, { secretScope: 'system' });
    assert.ok(record);
    assert.equal(JSON.parse(record).version, 1);
    assert.equal(record.includes('gateway-webhook-secret-fixture'), false);
    console.log('composio-webhook-subscription-secret-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    globalThis.fetch = originalFetch;
    await fs.rm(dataRoot, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in environmentBefore)) delete process.env[key];
    Object.assign(process.env, environmentBefore);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
