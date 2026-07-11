import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-agent-runtime-catalog-'));
process.env.DATA = dataDir;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => (
  request === 'server-only' ? {} : originalLoad(request, parent, isMain)
);

function installationId(organizationId: string, providerId: string, credentialScope: string): string {
  const digest = createHash('sha256')
    .update(`${organizationId}\0${providerId}\0${credentialScope}`)
    .digest('hex')
    .slice(0, 24);
  return `aip_${digest}`;
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const {
    AiCatalogValidationError,
    parseAiCatalogUpdate,
    replaceAiAppRuntimeCatalog,
  } = await import('../app/lib/agent-runtime-policy/catalog-service');
  const {
    CatalogRevisionConflictError,
    readAppRuntimeCatalog,
  } = await import('../app/lib/agent-runtime-policy/catalog-store');

  const owner = await createInitialOwner({
    name: 'Runtime Catalog Owner',
    email: 'runtime-catalog@example.test',
    password: 'RuntimeCatalogPassword123!',
  });
  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  const organization = sqlite.prepare(`
    SELECT organization_id AS organizationId
    FROM canvas_organization_settings
    LIMIT 1
  `).get() as { organizationId: string };
  assert.ok(organization.organizationId);

  assert.throws(
    () => parseAiCatalogUpdate({
      expectedRevision: 0,
      providers: [{
        providerId: 'openrouter',
        enabled: true,
        credentialScope: 'organization',
        config: { apiKey: 'must-never-be-stored' },
        modelIds: ['reasoning-model'],
        defaultModelId: 'reasoning-model',
      }],
      defaultSelection: null,
    }),
    (error) => error instanceof AiCatalogValidationError && error.code === 'SECRET_VALUE_NOT_ALLOWED',
  );

  const discovery = {
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      source: 'built-in' as const,
      models: [
        {
          id: 'reasoning-model',
          name: 'Reasoning Model',
          reasoning: true,
          supportsVision: true,
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
        {
          id: 'fast-model',
          name: 'Fast Model',
          reasoning: false,
          supportsVision: false,
          contextWindow: 64_000,
          maxTokens: 8_192,
        },
      ],
    },
  };
  const organizationInstallationId = installationId(organization.organizationId, 'openrouter', 'organization');
  const userInstallationId = installationId(organization.organizationId, 'openrouter', 'user');
  const update = parseAiCatalogUpdate({
    expectedRevision: 0,
    providers: [
      {
        providerInstallationId: organizationInstallationId,
        providerId: 'openrouter',
        enabled: true,
        credentialScope: 'organization',
        config: { authMethod: 'api-key' },
        modelIds: ['reasoning-model', 'fast-model'],
        defaultModelId: 'reasoning-model',
      },
      {
        providerInstallationId: userInstallationId,
        providerId: 'openrouter',
        enabled: true,
        credentialScope: 'user',
        config: { authMethod: 'oauth' },
        modelIds: ['fast-model'],
        defaultModelId: 'fast-model',
      },
    ],
    defaultSelection: {
      providerInstallationId: organizationInstallationId,
      providerId: 'openrouter',
      modelId: 'reasoning-model',
      thinkingLevel: 'high',
    },
  });

  const catalog = await replaceAiAppRuntimeCatalog({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
    update,
    discovery,
  });
  assert.equal(catalog.revision, 1);
  assert.equal(catalog.migrationState, 'configured');
  assert.equal(catalog.providers.length, 2);
  assert.equal(catalog.defaultSelection?.providerInstallationId, organizationInstallationId);
  assert.deepEqual(
    catalog.providers.find((provider) => provider.installationId === userInstallationId)?.models[0].thinkingLevels,
    ['off'],
  );
  assert.deepEqual(
    catalog.providers
      .find((provider) => provider.installationId === organizationInstallationId)
      ?.models.find((model) => model.id === 'reasoning-model')
      ?.thinkingLevels,
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  );

  const storedConfigs = sqlite.prepare(`
    SELECT config_json AS configJson
    FROM ai_provider_installations
    WHERE organization_id = ?
  `).all(organization.organizationId) as Array<{ configJson: string }>;
  assert.equal(storedConfigs.length, 2);
  assert.equal(storedConfigs.some((entry) => /must-never-be-stored|apiKey/u.test(entry.configJson)), false);

  const sessionColumns = sqlite.prepare('PRAGMA table_info(pi_sessions)').all() as Array<{ name: string }>;
  const sessionColumnNames = new Set(sessionColumns.map((column) => column.name));
  assert.equal(sessionColumnNames.has('runtime_provider_installation_id'), true);
  assert.equal(sessionColumnNames.has('runtime_catalog_revision'), true);
  assert.equal(sessionColumnNames.has('runtime_policy_revision'), true);
  assert.equal(sessionColumnNames.has('runtime_selection_source'), true);

  await assert.rejects(
    () => replaceAiAppRuntimeCatalog({
      organizationId: organization.organizationId,
      actorUserId: owner.id,
      update,
      discovery,
    }),
    (error) => error instanceof CatalogRevisionConflictError && error.currentRevision === 1,
  );

  const invalidModelUpdate = parseAiCatalogUpdate({
    expectedRevision: 1,
    providers: [{
      providerId: 'openrouter',
      enabled: true,
      credentialScope: 'organization',
      config: {},
      modelIds: ['unknown-model'],
      defaultModelId: 'unknown-model',
    }],
    defaultSelection: null,
  });
  await assert.rejects(
    () => replaceAiAppRuntimeCatalog({
      organizationId: organization.organizationId,
      actorUserId: owner.id,
      update: invalidModelUpdate,
      discovery,
    }),
    (error) => error instanceof AiCatalogValidationError && error.code === 'MODEL_NOT_AVAILABLE',
  );

  const mismatchedInstallationUpdate = parseAiCatalogUpdate({
    expectedRevision: 1,
    providers: [{
      providerInstallationId: `aip_${'f'.repeat(24)}`,
      providerId: 'openrouter',
      enabled: true,
      credentialScope: 'organization',
      config: {},
      modelIds: ['reasoning-model'],
      defaultModelId: 'reasoning-model',
    }],
    defaultSelection: null,
  });
  await assert.rejects(
    () => replaceAiAppRuntimeCatalog({
      organizationId: organization.organizationId,
      actorUserId: owner.id,
      update: mismatchedInstallationUpdate,
      discovery,
    }),
    (error) => error instanceof AiCatalogValidationError && error.code === 'INVALID_PROVIDER_INSTALLATION',
  );

  const preserved = await readAppRuntimeCatalog(organization.organizationId);
  assert.equal(preserved.revision, 1);
  assert.equal(preserved.providers.length, 2);
  sqlite.close();

  console.log('agent runtime catalog tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  });
