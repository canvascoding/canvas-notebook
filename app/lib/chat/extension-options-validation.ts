import 'server-only';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-contracts';
import { listExistingComposioProfiles } from '@/app/lib/composio/composio-profiles';
import { readPersonalComposioAccountReference } from '@/app/lib/composio/composio-shared-account-reference';
import { createIntegrationProviderRef } from '@/app/lib/integration-tools/references';
import { isComposioIntegrationApplicationVisible } from '@/app/lib/integration-tools/adapters/composio';
import { readAgentOwnMcpOptionMetadata, readAgentSharedMcpOptionMetadata, readAgentComposioOptionsCatalogue } from '@/app/lib/agents/extension-options-inventory';
import { capabilityPackageMcpConfigCompatibility } from '@/app/lib/capabilities/packages/mcp-template-matches';
import type { ExtensionSelectionInput, ExtensionPackageConnection } from '@/app/lib/capabilities/extensions/contracts';
import { chatStandaloneEligibility, chatStandaloneToolCap, resolveChatConnectionScope, intersectChatCaps } from './extension-options-eligibility';
import { authorizeChatExtensionSharedOption, revalidateChatExtensionOptionsContext, type ChatExtensionOptionsContext } from './extension-options-context';
import type { ChatPackageScopeMetadataOptions } from './extension-options-eligibility';

const fail = (message: string): never => { throw new AgentWorkflowError('CHAT_EXTENSION_SOURCE_UNAVAILABLE', message, 409); };
/** Source/intent coherence only. No account enumeration, health check, discovery, or execution grant. */
export async function validateChatConnectionMetadata(context: ChatExtensionOptionsContext,
  entry: Extract<ExtensionSelectionInput, { selection: unknown }>, signal: AbortSignal,
  mapping?: ExtensionPackageConnection, requireReceipt = true,
  options: ChatPackageScopeMetadataOptions = {}): Promise<{ toolCap: string[] | null }> {
  const selection = entry.selection;
  if (selection.kind !== 'mcp' && selection.kind !== 'composio') return fail('Choose one exact connection.');
  signal.throwIfAborted();
  if (selection.kind === 'composio' && !isComposioIntegrationApplicationVisible(selection.toolkit)) return fail('Use this app’s native tool.');
  let tools: string[] | null = null, definitionId: string | undefined;
  let config: import('@/app/lib/mcp/config').McpServerConfig | undefined;
  if (selection.target.kind === 'shared') {
    const shared = await authorizeChatExtensionSharedOption(context, selection.target.connectionRef);
    if (!shared.canUse || shared.resource.status !== 'active' || shared.resource.source !== selection.source
      || shared.resource.bindingRevision !== selection.target.bindingRevision) return fail('The shared connection changed or is unavailable.');
    tools = shared.allowedToolNames && [...shared.allowedToolNames];
    if (selection.kind === 'composio') {
      if (shared.backend.source !== 'composio' || shared.backend.toolkit !== selection.toolkit || shared.backend.accountBinding === 'pending') return fail('The selected shared app is not connected.');
    } else {
      const metadata = await readAgentSharedMcpOptionMetadata(context, selection.target.connectionRef);
      if (!metadata || metadata.connection.enabled === false) return fail('The selected MCP source is unavailable.');
      config = metadata.connection; definitionId = config.serverDefinitionId;
    }
  } else if (selection.kind === 'mcp') {
    const metadata = await readAgentOwnMcpOptionMetadata(context, selection.target.connectionRef);
    if (!metadata || metadata.connection.enabled === false) return fail('The exact personal MCP source is unavailable.');
    config = metadata.connection; definitionId = config.serverDefinitionId;
  } else {
    if (!isComposioIntegrationApplicationVisible(selection.toolkit)) return fail('Use the native integration tool for this app.');
    const target = selection.target;
    const profile = (await listExistingComposioProfiles(context.actor.userId)).find(profile => profile.id === target.profileId
      && profile.ownerUserId === context.actor.userId && profile.status === 'active');
    if (!profile) return fail('The exact personal profile is unavailable.');
    if (target.accountBinding === 'account') {
      if (requireReceipt && !entry.accountSelectionRef) return fail('Confirm this exact account again to obtain a current choice receipt.');
      if (entry.accountSelectionRef) {
        const receipt = readPersonalComposioAccountReference(entry.accountSelectionRef);
        const providerRef = createIntegrationProviderRef({ source: 'composio', profileId: target.profileId, toolkit: selection.toolkit,
          scope: { type: 'user', ownerUserId: context.actor.userId, resourceId: `profile:${target.profileId}:${selection.toolkit}` } });
        if (receipt.actorUserId !== context.actor.userId || receipt.organizationId !== context.organizationId
          || receipt.workspaceId !== context.actor.workspaceId || receipt.profileId !== target.profileId || receipt.accountId !== target.accountId
          || receipt.toolkit !== selection.toolkit || receipt.providerRef !== providerRef) return fail('The account receipt does not match this exact selection context.');
      }
    } else {
      const catalogue = await readAgentComposioOptionsCatalogue(context, signal, { profileId: target.profileId, search: selection.toolkit, selectedSlug: selection.toolkit });
      const app = catalogue.items.find(item => item.kind === 'integration' && item.toolkit.slug === selection.toolkit);
      if (app?.kind !== 'integration' || !app.toolkit.noAuth) return fail('This exact app does not declare no-auth operation.');
    }
  }
  if (!mapping) {
    const eligibility = chatStandaloneEligibility(context, selection, definitionId);
    if (eligibility.action !== 'select') return fail(eligibility.reason?.message ?? 'This source is outside the current agent configuration.');
    tools = intersectChatCaps(tools, chatStandaloneToolCap(context, selection, definitionId));
  } else {
    const scope = await resolveChatConnectionScope(context, { kind: 'package', package: mapping.package,
      declarationPath: mapping.declarationPath, capabilityId: mapping.capabilityId, alternativeKey: mapping.alternativeKey }, options);
    const exact = scope.allowed?.find(choice => JSON.stringify(choice.selection) === JSON.stringify(selection));
    if (scope.allowed && !exact && (selection.target.kind !== 'personal' || !scope.personal.length || scope.refreshOnly)) return fail('This exact source is outside the configured package choices.');
    if (!exact && selection.kind === 'mcp' && scope.definitionMappings
      && !scope.definitionMappings.some(value => value.connector === mapping.alternativeKey.slice(4)
        && definitionId && value.serverDefinitionIds.includes(definitionId))) return fail('This MCP definition is outside the package policy.');
    if (scope.template && (!config || !capabilityPackageMcpConfigCompatibility(scope.template, config as unknown as Record<string, unknown>))) return fail('The MCP connection does not match the exact published template.');
    tools = intersectChatCaps(tools, exact?.toolCap ?? scope.toolCap);
    const requiredTools = scope.alternatives[0]?.requiredTools ?? [];
    if (tools !== null && requiredTools.some(tool => !tools!.includes(tool))) return fail('The selected source does not permit every required tool.');
  }
  await revalidateChatExtensionOptionsContext(context);
  return { toolCap: intersectChatCaps(tools, entry.toolCap) };
}
