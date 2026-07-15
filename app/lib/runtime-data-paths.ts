import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

const CONTAINER_DATA_ROOT = '/data';

export type DataStorageScopeType = 'user' | 'organization' | 'system' | 'legacy';

export type UserScopedDataStorageScope = {
  userId?: string | null;
  organizationId?: string | null;
  scopeType?: DataStorageScopeType | null;
};

export type CapabilityDataStorageScope = UserScopedDataStorageScope;

export type ResolvedDataStorageScope = {
  scopeType: DataStorageScopeType;
  userId: string | null;
  organizationId: string | null;
};

export type SecretDataStorageScope = UserScopedDataStorageScope & {
  organizationId?: string | null;
  secretScope?: 'user' | 'organization' | 'system' | 'legacy';
};

function directoryExistsSync(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

export async function directoryExists(targetPath: string): Promise<boolean> {
  return fsPromises.stat(targetPath).then((stat) => stat.isDirectory()).catch(() => false);
}

export function createAtomicTempPath(targetPath: string): string {
  return `${targetPath}.tmp-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

function resolveProjectDataRoot(cwd?: string): string {
  const resolvedCwd = cwd ?? process.cwd();
  return path.resolve(/* turbopackIgnore: true */ resolvedCwd, 'data');
}

export function isDefaultDataEnvValue(value: string): boolean {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/\/+$/, '');
  return normalized === 'data';
}

export function resolveCanvasDataRoot(cwd?: string): string {
  const configured = process.env.CANVAS_DATA_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  const data = process.env.DATA?.trim();
  if (data && !isDefaultDataEnvValue(data)) {
    return path.isAbsolute(data)
      ? data
      : path.resolve(cwd ?? process.cwd(), data);
  }

  if (directoryExistsSync(CONTAINER_DATA_ROOT)) {
    return CONTAINER_DATA_ROOT;
  }

  return resolveProjectDataRoot(cwd);
}

export function resolveAgentStorageDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'canvas-agent');
}

export function resolveAgentsStorageRoot(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'agents');
}

export function normalizeDataScopeId(id: string, label = 'scope id'): string {
  const normalized = id.trim();
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized.includes('\0')
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

export function resolveUsersDataRoot(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'users');
}

export function resolveUserDataRoot(userId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveUsersDataRoot(cwd), normalizeDataScopeId(userId, 'userId'));
}

export function resolveUserSettingsDir(userId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveUserDataRoot(userId, cwd), 'settings');
}

export function resolveUserSecretsDir(userId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveUserDataRoot(userId, cwd), 'secrets');
}

export function resolveUserAgentsDir(userId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveUserDataRoot(userId, cwd), 'agents');
}

export function resolveUserSkillsDir(userId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveUserDataRoot(userId, cwd), 'skills');
}

export function resolveUserPluginsDir(userId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveUserDataRoot(userId, cwd), 'plugins');
}

export function resolveUserMcpDir(userId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveUserDataRoot(userId, cwd), 'mcp');
}

export function resolveUserMailDir(userId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveUserDataRoot(userId, cwd), 'mail');
}

export function resolveOrganizationsDataRoot(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'organizations');
}

export function resolveOrganizationDataRoot(organizationId: string, cwd?: string): string {
  return path.join(
    /* turbopackIgnore: true */ resolveOrganizationsDataRoot(cwd),
    normalizeDataScopeId(organizationId, 'organizationId'),
  );
}

export function resolveOrganizationSettingsDir(organizationId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveOrganizationDataRoot(organizationId, cwd), 'settings');
}

export function resolveOrganizationSecretsDir(organizationId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveOrganizationDataRoot(organizationId, cwd), 'secrets');
}

export function resolveOrganizationPoliciesDir(organizationId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveOrganizationDataRoot(organizationId, cwd), 'policies');
}

export function resolveOrganizationAgentTemplatesDir(organizationId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveOrganizationDataRoot(organizationId, cwd), 'agent-templates');
}

export function resolveOrganizationSkillTemplatesDir(organizationId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveOrganizationDataRoot(organizationId, cwd), 'skill-templates');
}

export function resolveOrganizationPluginTemplatesDir(organizationId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveOrganizationDataRoot(organizationId, cwd), 'plugin-templates');
}

export function resolveOrganizationSkillsDir(organizationId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveOrganizationDataRoot(organizationId, cwd), 'skills');
}

export function resolveOrganizationPluginsDir(organizationId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveOrganizationDataRoot(organizationId, cwd), 'plugins');
}

export function resolveOrganizationMcpTemplatesDir(organizationId: string, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveOrganizationDataRoot(organizationId, cwd), 'mcp-templates');
}

export function resolveSystemDataRoot(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'system');
}

export function resolveSystemSettingsDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSystemDataRoot(cwd), 'settings');
}

export function resolveSystemSecretsDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSystemDataRoot(cwd), 'secrets');
}

export function resolveSystemManagedDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSystemDataRoot(cwd), 'managed');
}

export function resolveSystemBackupsDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSystemDataRoot(cwd), 'backups');
}

export function resolveSystemMigrationDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSystemDataRoot(cwd), 'migration');
}

export function resolveSystemLogsDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSystemDataRoot(cwd), 'logs');
}

export function resolveSettingsStorageDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'settings');
}

export function resolveSecretsDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'secrets');
}

export function resolveSkillsDataDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'skills');
}

function resolveScopedUserId(scope?: UserScopedDataStorageScope | null): string | null {
  const userId = scope?.userId?.trim();
  return userId ? normalizeDataScopeId(userId, 'userId') : null;
}

function resolveScopedOrganizationId(scope?: UserScopedDataStorageScope | null): string | null {
  const organizationId = scope?.organizationId?.trim();
  return organizationId ? normalizeDataScopeId(organizationId, 'organizationId') : null;
}

export function resolveDataStorageScope(
  scope?: UserScopedDataStorageScope | null,
): ResolvedDataStorageScope {
  const userId = resolveScopedUserId(scope);
  const organizationId = resolveScopedOrganizationId(scope);
  const requestedScopeType = scope?.scopeType ?? null;

  if (requestedScopeType === 'user') {
    if (!userId) throw new Error('userId is required for user-scoped storage.');
    return { scopeType: 'user', userId, organizationId };
  }
  if (requestedScopeType === 'organization') {
    if (!organizationId) throw new Error('organizationId is required for organization-scoped storage.');
    return { scopeType: 'organization', userId: null, organizationId };
  }
  if (requestedScopeType === 'system') {
    return { scopeType: 'system', userId: null, organizationId: null };
  }
  if (requestedScopeType === 'legacy') {
    return { scopeType: 'legacy', userId: null, organizationId: null };
  }
  if (userId) {
    return { scopeType: 'user', userId, organizationId };
  }
  if (organizationId) {
    return { scopeType: 'organization', userId: null, organizationId };
  }
  return { scopeType: 'legacy', userId: null, organizationId: null };
}

export function resolveScopedSettingsDir(scope?: UserScopedDataStorageScope | null, cwd?: string): string {
  const resolvedScope = resolveDataStorageScope(scope);
  if (resolvedScope.scopeType === 'user') {
    return resolveUserSettingsDir(resolvedScope.userId!, cwd);
  }
  if (resolvedScope.scopeType === 'organization') {
    return resolveOrganizationSettingsDir(resolvedScope.organizationId!, cwd);
  }
  if (resolvedScope.scopeType === 'system') {
    return resolveSystemSettingsDir(cwd);
  }
  return resolveSettingsStorageDir(cwd);
}

export function resolveScopedPiOAuthStatesDir(scope?: UserScopedDataStorageScope | null, cwd?: string): string {
  const userId = resolveScopedUserId(scope);
  return userId
    ? path.join(/* turbopackIgnore: true */ resolveUserSettingsDir(userId, cwd), 'pi-oauth-states')
    : path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'pi-oauth-states');
}

export function resolveScopedSkillsDataDir(scope?: UserScopedDataStorageScope | null, cwd?: string): string {
  const resolvedScope = resolveDataStorageScope(scope);
  if (resolvedScope.scopeType === 'user') {
    return resolveUserSkillsDir(resolvedScope.userId!, cwd);
  }
  if (resolvedScope.scopeType === 'organization') {
    return resolveOrganizationSkillsDir(resolvedScope.organizationId!, cwd);
  }
  if (resolvedScope.scopeType === 'system') {
    return path.join(/* turbopackIgnore: true */ resolveSystemManagedDir(cwd), 'skills');
  }
  return resolveSkillsDataDir(cwd);
}

export function resolveScopedSkillRegistryPath(scope?: UserScopedDataStorageScope | null, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveScopedSkillsDataDir(scope, cwd), 'registry.json');
}

export function resolveScopedSkillBackupsDir(scope?: UserScopedDataStorageScope | null, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveScopedSkillsDataDir(scope, cwd), '.backups');
}

export async function shouldUseLegacyScopedSkillsFallback(
  scope?: UserScopedDataStorageScope | null,
  cwd?: string,
): Promise<boolean> {
  const resolvedScope = resolveDataStorageScope(scope);
  return resolvedScope.scopeType === 'user'
    && !(await directoryExists(resolveScopedSkillsDataDir(scope, cwd)));
}

export async function resolveReadableScopedSkillsDataDir(
  scope?: UserScopedDataStorageScope | null,
  cwd?: string,
): Promise<string> {
  return await shouldUseLegacyScopedSkillsFallback(scope, cwd)
    ? resolveScopedSkillsDataDir(null, cwd)
    : resolveScopedSkillsDataDir(scope, cwd);
}

export function resolveSkillRegistryPath(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSkillsDataDir(cwd), 'registry.json');
}

export function resolveSkillBackupsDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSkillsDataDir(cwd), '.backups');
}

export function resolvePluginsDataDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'plugins');
}

export function resolveInstalledPluginsDir(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolvePluginsDataDir(cwd), 'installed');
}

export function resolvePluginRegistryPath(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolvePluginsDataDir(cwd), 'registry.json');
}

export function resolveScopedPluginsDataDir(scope?: UserScopedDataStorageScope | null, cwd?: string): string {
  const resolvedScope = resolveDataStorageScope(scope);
  if (resolvedScope.scopeType === 'user') {
    return resolveUserPluginsDir(resolvedScope.userId!, cwd);
  }
  if (resolvedScope.scopeType === 'organization') {
    return resolveOrganizationPluginsDir(resolvedScope.organizationId!, cwd);
  }
  if (resolvedScope.scopeType === 'system') {
    return path.join(/* turbopackIgnore: true */ resolveSystemManagedDir(cwd), 'plugins');
  }
  return resolvePluginsDataDir(cwd);
}

export function resolveScopedInstalledPluginsDir(scope?: UserScopedDataStorageScope | null, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveScopedPluginsDataDir(scope, cwd), 'installed');
}

export function resolveScopedPluginRegistryPath(scope?: UserScopedDataStorageScope | null, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveScopedPluginsDataDir(scope, cwd), 'registry.json');
}

export async function shouldUseLegacyScopedPluginsFallback(
  scope?: UserScopedDataStorageScope | null,
  cwd?: string,
): Promise<boolean> {
  const resolvedScope = resolveDataStorageScope(scope);
  return resolvedScope.scopeType === 'user'
    && !(await directoryExists(resolveScopedPluginsDataDir(scope, cwd)));
}

export async function resolveReadableScopedPluginsDataDir(
  scope?: UserScopedDataStorageScope | null,
  cwd?: string,
): Promise<string> {
  return await shouldUseLegacyScopedPluginsFallback(scope, cwd)
    ? resolveScopedPluginsDataDir(null, cwd)
    : resolveScopedPluginsDataDir(scope, cwd);
}

export function resolveDefaultIntegrationsEnvPath(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSecretsDir(cwd), 'Canvas-Integrations.env');
}

export function resolveDefaultAgentsEnvPath(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSecretsDir(cwd), 'Canvas-Agents.env');
}

function resolveSecretDataScope(scope?: SecretDataStorageScope | null): 'user' | 'organization' | 'system' | 'legacy' {
  if (scope?.secretScope) {
    return scope.secretScope;
  }
  if (scope?.userId?.trim()) {
    return 'user';
  }
  if (scope?.organizationId?.trim()) {
    return 'organization';
  }
  return 'legacy';
}

export function resolveScopedSecretsDir(scope?: SecretDataStorageScope | null, cwd?: string): string {
  const secretScope = resolveSecretDataScope(scope);
  if (secretScope === 'user') {
    const userId = scope?.userId?.trim();
    if (!userId) {
      throw new Error('userId is required for user-scoped secrets.');
    }
    return resolveUserSecretsDir(userId, cwd);
  }
  if (secretScope === 'organization') {
    const organizationId = scope?.organizationId?.trim();
    if (!organizationId) {
      throw new Error('organizationId is required for organization-scoped secrets.');
    }
    return resolveOrganizationSecretsDir(organizationId, cwd);
  }
  if (secretScope === 'system') {
    return resolveSystemSecretsDir(cwd);
  }
  return resolveSecretsDir(cwd);
}

export function resolveScopedIntegrationsEnvPath(scope?: SecretDataStorageScope | null, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveScopedSecretsDir(scope, cwd), 'Canvas-Integrations.env');
}

export function resolveScopedAgentsEnvPath(scope?: SecretDataStorageScope | null, cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveScopedSecretsDir(scope, cwd), 'Canvas-Agents.env');
}

export function getUserUploadsRoot(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'user-uploads');
}

export function getUserUploadsStudioRefRoot(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'user-uploads', 'studio-references');
}
