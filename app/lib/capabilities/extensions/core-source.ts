import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { loadCoreCanvasPlugin } from '@/app/lib/plugins/core-plugin-loader';
import type { CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';
import type { CapabilityResourceActor } from '../resources/contracts';
import { withAuthorizedCapabilityPackageResource } from '../resources/store';
import { CapabilityPackageError } from '../packages/contracts';
import { corePluginSourceSchema, type CorePluginSource } from './core-source-contracts';

export function corePluginSource(plugin: CanvasPluginInstallRecord): CorePluginSource {
  return corePluginSourceSchema.parse({ resourceRef: plugin.resourceId, coreRevision: plugin.version, checksum: plugin.checksum });
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
  const plugin=await current();
  return withAuthorizedCapabilityPackageResource({userId:actor.userId,workspaceId:actor.workspaceId},{resourceType:'plugin',resourceId:source.resourceRef,scopeType:'system',sourceType:'core',
    name:plugin.name,organizationId:null,ownerUserId:null,sourcePluginId:null},'use',undefined,async(_authorization,database)=>{
      const result=await callback(await current(),database);await current();return result;
    },options);
}
