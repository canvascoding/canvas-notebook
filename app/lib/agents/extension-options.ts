import 'server-only';

import { listCapabilityResources } from '@/app/lib/capabilities/resources/actions';
import { findCapabilityResourceRecord } from '@/app/lib/capabilities/resources/store';
import { EXTENSION_SELECTION_LIMITS } from '@/app/lib/capabilities/extensions/contracts';
import { agentExtensionPackageIcon } from './extension-options-icons';
import type { AgentManagementActor } from './management-actions';
import { AgentWorkflowError } from './workflow-contracts';
import { agentExtensionOptionsRequestSchema, type AgentExtensionOptionsResponse } from './extension-options-contracts';
import { resolveAgentExtensionOptionsContext, revalidateAgentExtensionOptionsContext } from './extension-options-context';
import { readAgentExtensionPackageVersion } from './extension-package-options';
import { searchAgentExtensionOptions } from './extension-options-search';
import { listAgentExtensionConnectionChoices } from './extension-options-connections';
import { previewAgentExtensionConfiguration } from './extension-options-preview';

/** One actual options contract for UI and Agent tools, before and after creation. */
export async function listManagedAgentExtensionOptions(actorInput: AgentManagementActor, requestInput: unknown,
  options: { signal?: AbortSignal } = {}): Promise<AgentExtensionOptionsResponse> {
  const parsed = agentExtensionOptionsRequestSchema.safeParse(requestInput);
  if (!parsed.success) throw new AgentWorkflowError('AGENT_EXTENSION_OPTIONS_INVALID', 'Choose one exact extension selection operation and current target.', 400);
  const request = parsed.data, context = await resolveAgentExtensionOptionsContext(actorInput, request.target);
  const resourceActor = { userId: context.actor.userId, workspaceId: context.actor.workspaceId };
  options.signal?.throwIfAborted();
  if (request.operation === 'search') return searchAgentExtensionOptions(context, request, options.signal);
  if (request.operation === 'connection_choices') return listAgentExtensionConnectionChoices(context, request, options.signal);
  if (request.operation === 'preview') return previewAgentExtensionConfiguration(context, request);
  const { metadata, source } = await readAgentExtensionPackageVersion(resourceActor, {
    resourceRef: request.resourceRef, publishedRevisionRef: request.publishedRevisionRef,
    ...(request.checksum ? { checksum: request.checksum } : {}),
  }, { allowPersonalPackages: context.allowPersonal });
  const resources = await listCapabilityResources(resourceActor), record = await findCapabilityResourceRecord(metadata.resourceRef);
  const pin = { resourceRef: metadata.resourceRef, publishedRevisionRef: metadata.publishedRevisionRef, checksum: metadata.checksum };
  const icon = agentExtensionPackageIcon(pin, metadata.kind === 'plugin'
    ? [source.manifest?.interface?.logo, source.manifest?.interface?.icon]
    : [source.skills[0]?.skill.interface?.iconSmall, source.skills[0]?.skill.interface?.iconLarge], context.actor.workspaceId);
  const children = metadata.skillRoots.map(child => {
    const skill = source.skills.find(value => value.relativeRoot === child.relativeRoot)?.skill;
    const required = resources.some(resource => resource.access.canUse && resource.activation?.effectivePolicy === 'required'
      && (metadata.kind === 'skill' ? resource.metadata.resourceRef === metadata.resourceRef
        : resource.artifact.sourcePluginId === record?.storage.resourceId && resource.artifact.name === child.name));
    return { ...child, origin: metadata.kind === 'skill' ? 'standalone' as const : 'plugin_child' as const, required,
      icon: agentExtensionPackageIcon(pin, [skill?.interface?.iconSmall, skill?.interface?.iconLarge], context.actor.workspaceId, child.relativeRoot) };
  });
  await revalidateAgentExtensionOptionsContext(context);
  return { schemaVersion: 1, operation: 'package_version', target: request.target, contextKey: context.contextKey,
    coverage: [{ source: 'packages', status: 'complete' }], limits: EXTENSION_SELECTION_LIMITS,
    package: { pin, kind: metadata.kind, name: metadata.name, displayName: metadata.title,
      description: metadata.description, version: metadata.version, icon, children, declarations: metadata.declarations } };
}
