import 'server-only';

import path from 'node:path';
import type { CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';
import { parseSkillFile } from '@/app/lib/skills/canvas-skill-manifest';
import { corePluginSource } from '../extensions/core-source';
import type { CorePluginSource } from '../extensions/core-source-contracts';
import type { CapabilityCandidate } from '../types';
import { CapabilityPackageError } from './contracts';
import { compactExtensionMetadata, projectExtensionSkillMetadata, type ExtensionSkillMetadata } from './extension-context-metadata';
import { readExactPackageInventory } from './io';

export type CorePluginContextMetadata = Readonly<{
  kind: 'core_plugin'; coreSource: CorePluginSource; name: string; title: string; description: string;
  requirement: 'optional' | 'required';
  defaultPrompts: readonly string[]; skills: readonly ExtensionSkillMetadata[];
}>;

/** Presentation of a source held by the caller's withAuthorizedCorePluginSource; this issues no authority. */
export async function readCorePluginContextMetadata(plugin: CanvasPluginInstallRecord,
  candidates: readonly CapabilityCandidate[], options: { requirement?: 'optional' | 'required' } = {}): Promise<CorePluginContextMetadata> {
  const source = corePluginSource(plugin), skills: ExtensionSkillMetadata[] = [];
  for (const member of plugin.skills) {
    const candidate = candidates.find(value => value.ref.resourceType === 'skill' && value.ref.scopeType === 'system'
      && value.ref.name === member.name && value.runtimePath && path.resolve(value.runtimePath) === path.resolve(member.path)
      && (member.sourceType === 'seed' ? value.ref.sourceType === 'core'
        : value.ref.sourceType === 'plugin' && value.ref.sourcePluginId === plugin.resourceId));
    const skill = candidate && await parseSkillFile(member.path);
    if (!candidate || !skill || skill.name !== member.name || candidate.resourceAccess?.canUse === false) {
      throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The exact built-in plugin member is unavailable.', 403);
    }
    const inventory = await readExactPackageInventory(path.dirname(member.path));
    skills.push(Object.freeze({ ...projectExtensionSkillMetadata({ candidate, skill, required: options.requirement === 'required' }),
      coreSource: Object.freeze({ resourceId: candidate.ref.resourceId, checksum: inventory.checksum,
        parentResourceId: source.resourceRef, parentChecksum: source.checksum }) }));
  }
  return Object.freeze({ kind: 'core_plugin', coreSource: Object.freeze(source), name: plugin.name, requirement: options.requirement ?? 'optional',
    title: compactExtensionMetadata(plugin.interface?.displayName || plugin.name, 256),
    description: compactExtensionMetadata(plugin.description, 1_024),
    defaultPrompts: Object.freeze((plugin.interface?.defaultPrompt ?? []).slice(0, 4).map(value => compactExtensionMetadata(value, 1_024))),
    skills: Object.freeze(skills) });
}
