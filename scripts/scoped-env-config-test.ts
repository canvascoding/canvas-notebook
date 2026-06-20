import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-scoped-env-'));
  const previousCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const previousIntegrationsPath = process.env.INTEGRATIONS_ENV_PATH;
  const previousAgentsPath = process.env.AGENTS_ENV_PATH;
  const previousData = process.env.DATA;
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;

  try {
    process.env.CANVAS_DATA_ROOT = dataRoot;
    delete process.env.INTEGRATIONS_ENV_PATH;
    delete process.env.AGENTS_ENV_PATH;
    delete process.env.DATA;
    delete process.env.OPENAI_API_KEY;

    const {
      getEnvFilePath,
      getOpenAIApiKeyFromIntegrations,
      readScopedEnvState,
      replaceScopedEnvEntries,
      writeScopedEnvRaw,
    } = await import('../app/lib/integrations/env-config');

    const userA = { userId: 'user_a' };
    const userB = { userId: 'user_b' };
    const organization = { organizationId: 'org_1' };
    const system = { secretScope: 'system' as const };

    assert.equal(
      getEnvFilePath('integrations', userA),
      path.join(dataRoot, 'users', 'user_a', 'secrets', 'Canvas-Integrations.env'),
    );
    assert.equal(
      getEnvFilePath('agents', userA),
      path.join(dataRoot, 'users', 'user_a', 'secrets', 'Canvas-Agents.env'),
    );
    assert.equal(
      getEnvFilePath('integrations', organization),
      path.join(dataRoot, 'organizations', 'org_1', 'secrets', 'Canvas-Integrations.env'),
    );
    assert.equal(
      getEnvFilePath('agents', system),
      path.join(dataRoot, 'system', 'secrets', 'Canvas-Agents.env'),
    );

    await writeScopedEnvRaw('integrations', 'OPENAI_API_KEY=user-a-key\n', userA);
    await writeScopedEnvRaw('integrations', 'OPENAI_API_KEY=user-b-key\n', userB);
    await replaceScopedEnvEntries('agents', [{ key: 'OPENROUTER_API_KEY', value: 'user-a-router' }], userA);
    await replaceScopedEnvEntries('integrations', [{ key: 'ORG_API_KEY', value: 'org-key' }], organization);
    await replaceScopedEnvEntries('integrations', [{ key: 'SYSTEM_API_KEY', value: 'system-key' }], system);

    const userAIntegrations = await readScopedEnvState('integrations', userA);
    const userBIntegrations = await readScopedEnvState('integrations', userB);
    const userAAgents = await readScopedEnvState('agents', userA);
    const orgIntegrations = await readScopedEnvState('integrations', organization);
    const systemIntegrations = await readScopedEnvState('integrations', system);
    const legacyIntegrations = await readScopedEnvState('integrations');

    assert.equal(userAIntegrations.entries.find((entry) => entry.key === 'OPENAI_API_KEY')?.value, 'user-a-key');
    assert.equal(await getOpenAIApiKeyFromIntegrations(userA), 'user-a-key');
    assert.equal(userBIntegrations.entries.find((entry) => entry.key === 'OPENAI_API_KEY')?.value, 'user-b-key');
    assert.equal(userAAgents.entries.find((entry) => entry.key === 'OPENROUTER_API_KEY')?.value, 'user-a-router');
    assert.equal(orgIntegrations.entries.find((entry) => entry.key === 'ORG_API_KEY')?.value, 'org-key');
    assert.equal(systemIntegrations.entries.find((entry) => entry.key === 'SYSTEM_API_KEY')?.value, 'system-key');
    assert.equal(legacyIntegrations.exists, false);
    assert.equal(userAIntegrations.entries.some((entry) => entry.value === 'user-b-key'), false);

    const userAFileMode = (await fs.stat(userAIntegrations.path)).mode & 0o777;
    assert.equal(userAFileMode, 0o600);

    const overridePath = path.join(dataRoot, 'custom', 'Canvas-Integrations.env');
    process.env.INTEGRATIONS_ENV_PATH = overridePath;
    await writeScopedEnvRaw('integrations', 'LEGACY_KEY=legacy\n');
    assert.equal(getEnvFilePath('integrations'), overridePath);
    assert.equal(
      getEnvFilePath('integrations', userA),
      path.join(dataRoot, 'users', 'user_a', 'secrets', 'Canvas-Integrations.env'),
    );
    const legacyOverride = await readScopedEnvState('integrations');
    assert.equal(legacyOverride.entries.find((entry) => entry.key === 'LEGACY_KEY')?.value, 'legacy');

    console.log('scoped-env-config-test: ok');
  } finally {
    restoreEnv('CANVAS_DATA_ROOT', previousCanvasDataRoot);
    restoreEnv('INTEGRATIONS_ENV_PATH', previousIntegrationsPath);
    restoreEnv('AGENTS_ENV_PATH', previousAgentsPath);
    restoreEnv('DATA', previousData);
    restoreEnv('OPENAI_API_KEY', previousOpenAiApiKey);
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
