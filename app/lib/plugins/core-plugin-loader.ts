import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';
import { requirePathInside } from '@/app/lib/security/safe-paths';
import { computeCanvasPluginChecksum, parsePluginSkillsFromManifest, type CanvasPluginInstallRecord } from './canvas-plugin-registry';
import { validateCanvasPluginPackage } from './canvas-plugin-manifest';
import { CORE_PLUGIN_NAMES, corePluginResourceId, isCorePluginName } from './core-plugins';

export function resolveCorePluginRoot(name: string): string | null {
  return isCorePluginName(name) ? requirePathInside(path.join(process.cwd(), 'seed_plugins'), name.trim().toLowerCase()) : null;
}

/** Legacy Creator identity gets this one built-in read dependency, never provider authority. */
export function resolveCorePluginSkillReadDependencies(skillName: string): string[] {
  const root = resolveCorePluginRoot('plugin-creator');
  return skillName === 'create-plugin' && root ? [requirePathInside(root, 'skills', 'plugin-visual')] : [];
}

export async function loadCoreCanvasPlugin(name: string): Promise<CanvasPluginInstallRecord | null> {
  const root = resolveCorePluginRoot(name);
  if (!root) return null;
  const validation = await validateCanvasPluginPackage(root);
  if (!validation.valid || !validation.manifest || !validation.skillsDir || validation.manifest.name !== name) {
    throw new Error('The built-in Canvas plugin package is unavailable.');
  }
  const manifest = validation.manifest;
  const children = await parsePluginSkillsFromManifest(manifest, root, validation.skillsDir);
  if (children.errors.length || !children.records.length) throw new Error('The built-in Canvas plugin skills are unavailable.');
  const checksum = createHash('sha256').update(await computeCanvasPluginChecksum(root));
  for (const record of children.records.filter(skill => skill.sourceType === 'seed').sort((left, right) => left.name.localeCompare(right.name))) {
    checksum.update('\0').update(record.name).update('\0').update(await computeCanvasPluginChecksum(record.directory));
  }
  const bundledAt = '1970-01-01T00:00:00.000Z';
  return { ...manifest, core: true, sourceType: 'core', scopeType: 'system', resourceId: corePluginResourceId(name)!,
    organizationId: null, ownerUserId: null, revision: 1, enabled: true, installedAt: bundledAt, updatedAt: bundledAt,
    checksum: checksum.digest('hex'), installDir: root, manifestPath: requirePathInside(root, '.canvas-plugin', 'plugin.json'),
    skillsDir: validation.skillsDir, skills: children.records };
}

export async function loadCoreCanvasPlugins(): Promise<CanvasPluginInstallRecord[]> {
  const plugins = await Promise.all(CORE_PLUGIN_NAMES.map(name => loadCoreCanvasPlugin(name)));
  return plugins.filter((plugin): plugin is CanvasPluginInstallRecord => plugin !== null);
}
