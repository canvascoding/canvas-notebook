import 'server-only';

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  deleteCanvasPlugin,
  getCanvasPlugin,
  installCanvasPluginFromPath,
  setCanvasPluginEnabled,
  type CanvasPluginInstallRecord,
} from '@/app/lib/plugins/canvas-plugin-registry';
import { isValidCanvasPluginName, isValidCanvasPluginVersion } from '@/app/lib/plugins/canvas-plugin-manifest';

const PLUGIN_DRAFTS_DIR_NAME = '.canvas-plugin-drafts';

export type AgentPluginScope = {
  userId: string;
};

export type AgentPluginInspection = {
  name: string;
  installed: boolean;
  version?: string;
  description?: string;
  enabled?: boolean;
  checksum?: string;
  skills?: string[];
  reason?: string;
};

export type AgentPluginWorkspaceResult = {
  name: string;
  version: string;
  enabled: boolean;
  checksum: string;
  skills: string[];
  workspacePath: string;
};

export type AgentPluginDraftResult = {
  draftId: string;
  draftPath: string;
  packagePath: string;
  pluginName: string;
  version: string;
  skillName: string;
};

function assertPluginName(name: string): string {
  const normalized = name.trim();
  if (!isValidCanvasPluginName(normalized)) {
    throw new Error('Invalid plugin name. Use lowercase letters, numbers, and single hyphens only.');
  }
  return normalized;
}

function workspaceRelativePath(workspaceRoot: string, targetPath: string): string {
  return path.relative(workspaceRoot, targetPath).split(path.sep).join('/');
}

function normalizeDraftId(draftId?: string): string {
  const candidate = draftId?.trim() || randomUUID();
  if (!/^[a-zA-Z0-9._-]+$/.test(candidate) || candidate === '.' || candidate === '..') {
    throw new Error('Invalid draftId.');
  }
  return candidate;
}

async function resolveWorkspacePluginPath(workspaceRoot: string, workspacePath: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, workspacePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Plugin workspace path must stay inside the active workspace.');
  }

  const stat = await fs.lstat(candidate).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Plugin workspace path must be an existing non-symlink directory.');
  }

  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('Plugin workspace path must stay inside the active workspace.');
  }
  return candidate;
}

function summarizePlugin(record: CanvasPluginInstallRecord, workspacePath: string): AgentPluginWorkspaceResult {
  return {
    name: record.name,
    version: record.version,
    enabled: record.enabled,
    checksum: record.checksum,
    skills: record.skills.map((skill) => skill.name),
    workspacePath,
  };
}

export async function createCanvasPluginDraft(params: {
  workspaceRoot: string;
  pluginName: string;
  description?: string;
  version?: string;
  draftId?: string;
  overwrite?: boolean;
}): Promise<AgentPluginDraftResult> {
  const pluginName = assertPluginName(params.pluginName);
  const version = params.version?.trim() || '1.0.0';
  if (!isValidCanvasPluginVersion(version)) {
    throw new Error('Invalid plugin version. Use a simple version such as 1.0.0.');
  }
  const description = params.description?.trim() || `Personal Canvas plugin ${pluginName}.`;
  const workspaceRoot = path.resolve(params.workspaceRoot);
  const draftId = normalizeDraftId(params.draftId);
  const draftPath = path.join(workspaceRoot, PLUGIN_DRAFTS_DIR_NAME, draftId);
  const packagePath = path.join(draftPath, pluginName);
  const existing = await fs.lstat(packagePath).catch(() => null);
  if (existing && params.overwrite !== true) {
    throw new Error(`Plugin draft already exists: ${workspaceRelativePath(workspaceRoot, packagePath)}`);
  }

  await fs.rm(packagePath, { recursive: true, force: true });
  const skillName = pluginName;
  await fs.mkdir(path.join(packagePath, '.canvas-plugin'), { recursive: true });
  await fs.mkdir(path.join(packagePath, 'skills', skillName, 'agents'), { recursive: true });
  await fs.writeFile(path.join(packagePath, '.canvas-plugin', 'plugin.json'), `${JSON.stringify({
    name: pluginName,
    version,
    description,
    license: 'MIT',
    skills: './skills',
    interface: {
      displayName: pluginName.replace(/-/g, ' '),
      shortDescription: description,
    },
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(packagePath, 'skills', skillName, 'SKILL.md'), [
    '---',
    `name: ${skillName}`,
    `description: ${JSON.stringify(description)}`,
    'metadata:',
    `  version: ${JSON.stringify(version)}`,
    '---',
    '',
    `# ${pluginName}`,
    '',
    description,
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(packagePath, 'skills', skillName, 'agents', 'canvas.yaml'), [
    'skill:',
    `  version: ${JSON.stringify(version)}`,
    'interface:',
    `  display_name: ${JSON.stringify(pluginName.replace(/-/g, ' '))}`,
    `  short_description: ${JSON.stringify(description)}`,
    '',
  ].join('\n'), 'utf8');

  return {
    draftId,
    draftPath: workspaceRelativePath(workspaceRoot, draftPath),
    packagePath: workspaceRelativePath(workspaceRoot, packagePath),
    pluginName,
    version,
    skillName,
  };
}

export async function inspectCanvasPluginForAgent(params: {
  pluginName: string;
  scope: AgentPluginScope;
}): Promise<AgentPluginInspection> {
  const name = assertPluginName(params.pluginName);
  const plugin = await getCanvasPlugin(name, { userId: params.scope.userId });
  if (!plugin) {
    return { name, installed: false, reason: 'Plugin is not installed for this user.' };
  }
  return {
    name: plugin.name,
    installed: true,
    version: plugin.version,
    description: plugin.description,
    enabled: plugin.enabled,
    checksum: plugin.checksum,
    skills: plugin.skills.map((skill) => skill.name),
  };
}

export async function installCanvasPluginFromWorkspace(params: {
  workspaceRoot: string;
  workspacePath: string;
  scope: AgentPluginScope;
  enable?: boolean;
  updatedBy?: string;
}): Promise<AgentPluginWorkspaceResult> {
  const packageRoot = await resolveWorkspacePluginPath(params.workspaceRoot, params.workspacePath);
  const result = await installCanvasPluginFromPath(packageRoot, {
    enable: params.enable,
    installedBy: params.updatedBy,
    sourcePathLabel: workspaceRelativePath(params.workspaceRoot, packageRoot),
    scope: { userId: params.scope.userId },
  });
  if (!result.success || !result.plugin) {
    throw new Error(result.error || result.validation?.errors.join('\n') || 'Failed to install plugin package.');
  }
  return summarizePlugin(result.plugin, workspaceRelativePath(params.workspaceRoot, packageRoot));
}

export async function updateCanvasPluginFromWorkspace(params: {
  workspaceRoot: string;
  workspacePath: string;
  pluginName: string;
  expectedVersion: string;
  expectedChecksum: string;
  scope: AgentPluginScope;
  enable?: boolean;
  updatedBy?: string;
}): Promise<AgentPluginWorkspaceResult & { previousVersion: string; previousChecksum: string }> {
  const pluginName = assertPluginName(params.pluginName);
  const existing = await getCanvasPlugin(pluginName, { userId: params.scope.userId });
  if (!existing) {
    throw new Error(`Plugin "${pluginName}" is not installed.`);
  }
  if (existing.version !== params.expectedVersion || existing.checksum !== params.expectedChecksum) {
    throw new Error('Plugin changed since inspection. Inspect it again before updating.');
  }

  const packageRoot = await resolveWorkspacePluginPath(params.workspaceRoot, params.workspacePath);
  const result = await installCanvasPluginFromPath(packageRoot, {
    enable: params.enable ?? existing.enabled,
    replace: true,
    installedBy: params.updatedBy,
    sourcePathLabel: workspaceRelativePath(params.workspaceRoot, packageRoot),
    scope: { userId: params.scope.userId },
  });
  if (!result.success || !result.plugin) {
    throw new Error(result.error || result.validation?.errors.join('\n') || 'Failed to update plugin package.');
  }
  return {
    ...summarizePlugin(result.plugin, workspaceRelativePath(params.workspaceRoot, packageRoot)),
    previousVersion: existing.version,
    previousChecksum: existing.checksum,
  };
}

export async function setCanvasPluginEnabledForAgent(params: {
  pluginName: string;
  enabled: boolean;
  scope: AgentPluginScope;
  updatedBy?: string;
}): Promise<AgentPluginWorkspaceResult> {
  const name = assertPluginName(params.pluginName);
  const result = await setCanvasPluginEnabled(name, params.enabled, { userId: params.scope.userId }, params.updatedBy);
  if (!result.success || !result.plugin) {
    throw new Error(result.error || 'Failed to update plugin activation.');
  }
  return summarizePlugin(result.plugin, 'installed plugin');
}

export async function removeCanvasPluginForAgent(params: {
  pluginName: string;
  scope: AgentPluginScope;
  updatedBy?: string;
}): Promise<{ name: string; removed: true }> {
  const name = assertPluginName(params.pluginName);
  const result = await deleteCanvasPlugin(name, { userId: params.scope.userId }, params.updatedBy);
  if (!result.success) {
    const conflictHint = result.conflicts?.length ? ` Conflicts: ${result.conflicts.join(', ')}.` : '';
    throw new Error(`${result.error || 'Failed to remove plugin.'}${conflictHint}`);
  }
  return { name, removed: true };
}
