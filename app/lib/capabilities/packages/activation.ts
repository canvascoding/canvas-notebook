import 'server-only';

import type { CapabilityResourceActor } from '../resources/contracts';
import { findCapabilityResourceRecord, withAuthorizedCapabilityPackageResource } from '../resources/store';
import { readCanvasPluginRegistry, writeCanvasPluginRegistry } from '@/app/lib/plugins/canvas-plugin-registry';
import { readCanvasSkillRegistry, writeCanvasSkillRegistry } from '@/app/lib/skills/canvas-skill-store';
import { refreshCapabilityRuntimeForScope } from '../activation-actions';
import { CapabilityPackageError } from './contracts';
import { capabilityPackageActivationSchema, capabilityPackageReferenceSchema } from './schemas';
import { capabilityPackageRegistryStorage, resolveCapabilityPackageArtifact, withCapabilityPackageRegistryPublication,
  assertCapabilityPackageRegistryPointerCurrent } from './artifacts';
import { getCapabilityPackageState, withCapabilityPackageActivation } from './store';

export async function setCapabilityPackageDefaultActivationAction(actor: CapabilityResourceActor, resourceRef: string, value: unknown) {
  const input = capabilityPackageActivationSchema.parse(structuredClone(value));
  const reference = capabilityPackageReferenceSchema.parse(resourceRef);
  const installed = await findCapabilityResourceRecord(reference);
  if (!installed) throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The managed package was not found.', 404);
  return withCapabilityPackageRegistryPublication(installed.storage, async () => {
    const source = await resolveCapabilityPackageArtifact(actor, reference);
    if (source.readOnly) throw new CapabilityPackageError('PACKAGE_READ_ONLY', 'Change activation on the owning editable package.', 403);
    const scope = capabilityPackageRegistryStorage(source.storage);
    const result = await withAuthorizedCapabilityPackageResource(actor, source.storage, 'read', input, async (authorization, database) => {
      if (!authorization.access.canManage) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'Package management permission is required to change default activation.', 403);
      const state = await getCapabilityPackageState(authorization.record.metadata.resourceRef, database);
      if (!state || state.packageRevision !== input.expectedPackageRevision || state.currentPublishedRevisionRef !== input.expectedPublishedRevisionRef) {
        throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'The published package changed. Inspect it again.', 409);
      }
      const plugins = source.storage.resourceType === 'plugin' ? await readCanvasPluginRegistry(scope) : null;
      const skills = source.storage.resourceType === 'skill' ? await readCanvasSkillRegistry(scope) : null;
      const current = plugins?.plugins[source.storage.name] || skills?.skills[source.storage.name];
      if (!current || current.packageResourceRef !== state.resourceRef || current.publishedRevisionRef !== state.currentPublishedRevisionRef) {
        throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The installed publication is unavailable.', 503);
      }
      await assertCapabilityPackageRegistryPointerCurrent(source.storage.resourceType, current, scope);
      const enabled = plugins ? plugins.plugins[source.storage.name].enabled : skills!.skills[source.storage.name].packageDefaultEnabled !== false;
      if (enabled !== input.expectedDefaultEnabled) throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'Default activation changed. Reload before changing it.', 409);
      await withCapabilityPackageActivation(authorization, { revisionRef: state.currentPublishedRevisionRef, version: current.version,
        checksum: current.checksum, rootPath: current.installDir, previousEnabled: enabled }, input.enabled, database, async () => {
        if (plugins) {
          plugins.plugins[source.storage.name] = { ...plugins.plugins[source.storage.name], enabled: input.enabled };
          await writeCanvasPluginRegistry(plugins, scope);
        } else {
          skills!.skills[source.storage.name] = { ...skills!.skills[source.storage.name], packageDefaultEnabled: input.enabled };
          await writeCanvasSkillRegistry(skills!, scope);
        }
      });
      return { enabled: input.enabled, resourceRef: state.resourceRef, packageRevision: state.packageRevision,
        publishedRevisionRef: state.currentPublishedRevisionRef };
    });
    await refreshCapabilityRuntimeForScope({ actorUserId: actor.userId, scope });
    return result;
  });
}
