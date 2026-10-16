import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { loadCoreCanvasPlugin } from '@/app/lib/plugins/core-plugin-loader';
import type { CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';
import type { CapabilityResourceActor } from '../resources/contracts';
import { withAuthorizedCapabilityPackageResource } from '../resources/store';
import { CapabilityPackageError } from '../packages/contracts';
import { corePluginSourceSchema, coreSkillSourceSchema, type CorePluginSource, type CoreSkillSource, type CoreExtensionSelection } from './core-source-contracts';
import { isCoreSkillName } from '@/app/lib/skills/core-skills';
import type { CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import { loadCoreSkillByName, resolveCoreSkillDir } from '@/app/lib/skills/core-skill-loader';
import { readExactPackageInventory } from '../packages/io';
import type { CapabilityResourceStorageBinding } from '../resources/contracts';

export function corePluginSource(plugin: CanvasPluginInstallRecord): CorePluginSource {
  return corePluginSourceSchema.parse({ resourceRef: plugin.resourceId, coreRevision: plugin.version, checksum: plugin.checksum });
}

/** Server-derived full seed inventory, preserving the existing public Core skill identity. */
export async function loadCoreSkillSource(nameOrRef: string): Promise<{ source: CoreSkillSource; skill: CanvasSkill }> {
  const name = nameOrRef.startsWith('canvas-capability:v1:skill:system:core:')
    ? nameOrRef.slice('canvas-capability:v1:skill:system:core:'.length) : nameOrRef;
  if (!isCoreSkillName(name) || name !== name.trim()) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'An existing built-in skill is required.', 400);
  const root = resolveCoreSkillDir(name)!;
  const skill = await loadCoreSkillByName(name);
  if (!skill || skill.name !== name || !skill.version) throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The built-in skill source is unavailable.', 409);
  const inventory = await readExactPackageInventory(root);
  return { skill, source: coreSkillSourceSchema.parse({ resourceRef: `canvas-capability:v1:skill:system:core:${name}`,
    coreRevision: skill.version, checksum: inventory.checksum }) };
}

/** One held Use/hash lifecycle serves actual bundled plugins and standalone Core skills. */
async function withCurrentCoreSource<T, D>(actor: CapabilityResourceActor,
  storage: CapabilityResourceStorageBinding, current: () => Promise<D>,
  callback: (definition: D, database: SqlConnection) => Promise<T>, options: { database?: SqlConnection }): Promise<T> {
  await current();
  return withAuthorizedCapabilityPackageResource({ userId: actor.userId, workspaceId: actor.workspaceId }, storage, 'use', undefined,
    async (_authorization, database) => {
      const result = await callback(await current(), database);
      await current();
      return result;
    }, options);
}

/** Current actor/use authority and actual bundled bytes, without synthesizing a published pin. */
export async function withAuthorizedCorePluginSource<T>(actor: CapabilityResourceActor, value: unknown,
  callback: (plugin: CanvasPluginInstallRecord, database: SqlConnection) => Promise<T>, options: {database?:SqlConnection} = {}): Promise<T> {
  const parsed=corePluginSourceSchema.safeParse(value);
  if(!parsed.success) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID','An exact built-in plugin source is required.',400);
  const source=parsed.data;
  const current=async()=>{
    const plugin=await loadCoreCanvasPlugin('plugin-creator');
    if(!plugin || JSON.stringify(corePluginSource(plugin))!==JSON.stringify(source)) {
      throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED','The built-in plugin changed. Select its current exact source again.',409);
    }
    return plugin;
  };
  return withCurrentCoreSource(actor,{resourceType:'plugin',resourceId:source.resourceRef,scopeType:'system',sourceType:'core',
    name:'plugin-creator',organizationId:null,ownerUserId:null,sourcePluginId:null},current,callback,options);
}

export async function withAuthorizedCoreSkillSource<T>(actor: CapabilityResourceActor, value: unknown,
  callback: (skill: CanvasSkill, database: SqlConnection) => Promise<T>, options: { database?: SqlConnection } = {}): Promise<T> {
  const parsed = coreSkillSourceSchema.safeParse(value);
  if (!parsed.success) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'An exact built-in skill source is required.', 400);
  const source = parsed.data;
  const current = async () => {
    const actual = await loadCoreSkillSource(source.resourceRef);
    if (JSON.stringify(actual.source) !== JSON.stringify(source)) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The built-in skill changed. Select its current exact source again.', 409);
    return actual.skill;
  };
  return withCurrentCoreSource(actor,{resourceType:'skill',resourceId:source.resourceRef,scopeType:'system',sourceType:'core',
    name:source.resourceRef.slice('canvas-capability:v1:skill:system:core:'.length),organizationId:null,ownerUserId:null,sourcePluginId:null},current,callback,options);
}

/** Public identity parsing grants no authority; every consumer holds the actual current source. */
export function withAuthorizedCoreExtensionSelection<T>(actor: CapabilityResourceActor, selection: CoreExtensionSelection,
  callback: (database: SqlConnection) => Promise<T>, options: {database?:SqlConnection} = {}): Promise<T> {
  return selection.kind === 'core_plugin'
    ? withAuthorizedCorePluginSource(actor, selection.coreSource, (_plugin, database) => callback(database), options)
    : withAuthorizedCoreSkillSource(actor, selection.coreSource, (_skill, database) => callback(database), options);
}
