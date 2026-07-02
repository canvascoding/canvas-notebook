import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-scoped-paths-'));
  const previousCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const previousData = process.env.DATA;

  try {
    process.env.CANVAS_DATA_ROOT = dataDir;
    process.env.DATA = '';

    const {
      isDefaultDataEnvValue,
      normalizeDataScopeId,
      resolveCanvasDataRoot,
      resolveOrganizationAgentTemplatesDir,
      resolveOrganizationMcpTemplatesDir,
      resolveOrganizationPluginTemplatesDir,
      resolveOrganizationPoliciesDir,
      resolveOrganizationSecretsDir,
      resolveOrganizationSkillTemplatesDir,
      resolveOrganizationDataRoot,
      resolveScopedInstalledPluginsDir,
      resolveScopedAgentsEnvPath,
      resolveScopedIntegrationsEnvPath,
      resolveScopedPiOAuthStatesDir,
      resolveScopedPluginRegistryPath,
      resolveScopedPluginsDataDir,
      resolveScopedSettingsDir,
      resolveScopedSecretsDir,
      resolveScopedSkillBackupsDir,
      resolveScopedSkillRegistryPath,
      resolveScopedSkillsDataDir,
      resolveSystemBackupsDir,
      resolveSystemLogsDir,
      resolveSystemManagedDir,
      resolveSystemMigrationDir,
      resolveSystemSecretsDir,
      resolveUserAgentsDir,
      resolveUserMailDir,
      resolveUserMcpDir,
      resolveUserPluginsDir,
      resolveUserSecretsDir,
      resolveUserSettingsDir,
      resolveUserSkillsDir,
    } = await import('../app/lib/runtime-data-paths');

    assert.equal(resolveCanvasDataRoot(), dataDir);
    for (const defaultDataValue of ['data', './data', 'data/', './data/', 'data/.', './data/.']) {
      assert.equal(isDefaultDataEnvValue(defaultDataValue), true);
    }
    for (const configuredDataValue of ['/data', 'canvas-data', './canvas-data', '../data']) {
      assert.equal(isDefaultDataEnvValue(configuredDataValue), false);
    }

    assert.equal(normalizeDataScopeId(' user_a ', 'userId'), 'user_a');
    assert.equal(resolveUserSettingsDir('user_a'), path.join(dataDir, 'users', 'user_a', 'settings'));
    assert.equal(resolveUserSecretsDir('user_a'), path.join(dataDir, 'users', 'user_a', 'secrets'));
    assert.equal(resolveUserAgentsDir('user_a'), path.join(dataDir, 'users', 'user_a', 'agents'));
    assert.equal(resolveUserSkillsDir('user_a'), path.join(dataDir, 'users', 'user_a', 'skills'));
    assert.equal(resolveUserPluginsDir('user_a'), path.join(dataDir, 'users', 'user_a', 'plugins'));
    assert.equal(resolveUserMcpDir('user_a'), path.join(dataDir, 'users', 'user_a', 'mcp'));
    assert.equal(resolveUserMailDir('user_a'), path.join(dataDir, 'users', 'user_a', 'mail'));
    assert.equal(resolveScopedSettingsDir({ userId: 'user_a' }), path.join(dataDir, 'users', 'user_a', 'settings'));
    assert.equal(resolveScopedPiOAuthStatesDir({ userId: 'user_a' }), path.join(dataDir, 'users', 'user_a', 'settings', 'pi-oauth-states'));
    assert.equal(resolveScopedPiOAuthStatesDir(), path.join(dataDir, 'pi-oauth-states'));
    assert.equal(resolveScopedSecretsDir({ userId: 'user_a' }), path.join(dataDir, 'users', 'user_a', 'secrets'));
    assert.equal(resolveScopedIntegrationsEnvPath({ userId: 'user_a' }), path.join(dataDir, 'users', 'user_a', 'secrets', 'Canvas-Integrations.env'));
    assert.equal(resolveScopedAgentsEnvPath({ userId: 'user_a' }), path.join(dataDir, 'users', 'user_a', 'secrets', 'Canvas-Agents.env'));
    assert.equal(resolveScopedSkillsDataDir({ userId: 'user_a' }), path.join(dataDir, 'users', 'user_a', 'skills'));
    assert.equal(resolveScopedSkillRegistryPath({ userId: 'user_a' }), path.join(dataDir, 'users', 'user_a', 'skills', 'registry.json'));
    assert.equal(resolveScopedSkillBackupsDir({ userId: 'user_a' }), path.join(dataDir, 'users', 'user_a', 'skills', '.backups'));
    assert.equal(resolveScopedPluginsDataDir({ userId: 'user_a' }), path.join(dataDir, 'users', 'user_a', 'plugins'));
    assert.equal(resolveScopedInstalledPluginsDir({ userId: 'user_a' }), path.join(dataDir, 'users', 'user_a', 'plugins', 'installed'));
    assert.equal(resolveScopedPluginRegistryPath({ userId: 'user_a' }), path.join(dataDir, 'users', 'user_a', 'plugins', 'registry.json'));

    assert.equal(resolveOrganizationDataRoot('org_1'), path.join(dataDir, 'organizations', 'org_1'));
    assert.equal(resolveOrganizationSecretsDir('org_1'), path.join(dataDir, 'organizations', 'org_1', 'secrets'));
    assert.equal(resolveOrganizationPoliciesDir('org_1'), path.join(dataDir, 'organizations', 'org_1', 'policies'));
    assert.equal(resolveOrganizationAgentTemplatesDir('org_1'), path.join(dataDir, 'organizations', 'org_1', 'agent-templates'));
    assert.equal(resolveOrganizationSkillTemplatesDir('org_1'), path.join(dataDir, 'organizations', 'org_1', 'skill-templates'));
    assert.equal(resolveOrganizationPluginTemplatesDir('org_1'), path.join(dataDir, 'organizations', 'org_1', 'plugin-templates'));
    assert.equal(resolveOrganizationMcpTemplatesDir('org_1'), path.join(dataDir, 'organizations', 'org_1', 'mcp-templates'));

    assert.equal(resolveSystemSecretsDir(), path.join(dataDir, 'system', 'secrets'));
    assert.equal(resolveScopedSecretsDir({ secretScope: 'system' }), path.join(dataDir, 'system', 'secrets'));
    assert.equal(resolveScopedSecretsDir({ organizationId: 'org_1' }), path.join(dataDir, 'organizations', 'org_1', 'secrets'));
    assert.equal(resolveScopedIntegrationsEnvPath({ organizationId: 'org_1' }), path.join(dataDir, 'organizations', 'org_1', 'secrets', 'Canvas-Integrations.env'));
    assert.equal(resolveScopedAgentsEnvPath({ secretScope: 'system' }), path.join(dataDir, 'system', 'secrets', 'Canvas-Agents.env'));
    assert.equal(resolveSystemManagedDir(), path.join(dataDir, 'system', 'managed'));
    assert.equal(resolveSystemBackupsDir(), path.join(dataDir, 'system', 'backups'));
    assert.equal(resolveSystemMigrationDir(), path.join(dataDir, 'system', 'migration'));
    assert.equal(resolveSystemLogsDir(), path.join(dataDir, 'system', 'logs'));

    for (const invalid of ['', ' ', '.', '..', '../user', 'team/a', 'team\\a', `team${String.fromCharCode(0)}a`]) {
      assert.throws(() => normalizeDataScopeId(invalid, 'scope'), /Invalid scope/);
    }

    const dataEnvRoot = path.join(dataDir, 'data-env-root');
    process.env.CANVAS_DATA_ROOT = '';
    process.env.DATA = dataEnvRoot;
    assert.equal(resolveCanvasDataRoot(), dataEnvRoot);

    console.log('scoped-runtime-paths-test: ok');
  } finally {
    if (previousCanvasDataRoot === undefined) {
      delete process.env.CANVAS_DATA_ROOT;
    } else {
      process.env.CANVAS_DATA_ROOT = previousCanvasDataRoot;
    }
    if (previousData === undefined) {
      delete process.env.DATA;
    } else {
      process.env.DATA = previousData;
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
