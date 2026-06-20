import fs from 'node:fs';
import path from 'node:path';

const CONTAINER_DATA_ROOT = '/data';

function directoryExists(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveProjectDataRoot(cwd?: string): string {
  const resolvedCwd = cwd ?? process.cwd();
  return path.resolve(/* turbopackIgnore: true */ resolvedCwd, 'data');
}

export function resolveCanvasDataRoot(cwd?: string): string {
  const configured = process.env.CANVAS_DATA_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  const data = process.env.DATA?.trim();
  if (data && data !== './data' && data !== 'data') {
    return path.isAbsolute(data)
      ? data
      : path.resolve(cwd ?? process.cwd(), data);
  }

  if (directoryExists(CONTAINER_DATA_ROOT)) {
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

export function resolveDefaultIntegrationsEnvPath(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSecretsDir(cwd), 'Canvas-Integrations.env');
}

export function resolveDefaultAgentsEnvPath(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveSecretsDir(cwd), 'Canvas-Agents.env');
}

export function getUserUploadsRoot(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'user-uploads');
}

export function getUserUploadsStudioRefRoot(cwd?: string): string {
  return path.join(/* turbopackIgnore: true */ resolveCanvasDataRoot(cwd), 'user-uploads', 'studio-references');
}
