import 'server-only';

import { listExistingComposioProfiles } from '@/app/lib/composio/composio-profiles';
import { projectAgentStandaloneConfigurations } from '@/app/lib/capabilities/extensions/agent-standalone-configuration';
import { authorizeIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { mcpIconSourceBinding } from '@/app/lib/mcp/icon-source';
import { mcpPluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import type { AgentExtensionStandaloneSummary } from './extension-presentation-contracts';
import { authorizeAgentExtensionSharedOption, revalidateAgentExtensionOptionsContext, type AgentExtensionOptionsContext } from './extension-options-context';
import { readAgentOwnMcpOptionMetadata, readAgentSharedMcpOptionMetadata, readAgentComposioOptionsCatalogue } from './extension-options-inventory';
import type { PluginExtensionItem } from '@/app/lib/plugins/plugin-extension-contracts';
import { AgentWorkflowError } from './workflow-contracts';

const display = (value: unknown): string => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 256) : '';

/** Only genuine persisted editable slots. Toolkit metadata is optional; no accounts/status/tools are queried. */
export async function readAgentExtensionStandalonePresentation(context: AgentExtensionOptionsContext) {
  await revalidateAgentExtensionOptionsContext(context);
  if (context.target.kind !== 'existing' || !context.snapshot) {
    throw new AgentWorkflowError('AGENT_ACCESS_DENIED', 'A current editable persisted agent is required.', 403);
  }
  const slots = await projectAgentStandaloneConfigurations(context.actor, context.snapshot);
  const entries = slots.flatMap(slot => (slot.mode === 'fixed' ? [{ ...slot.entry, choiceId: undefined }]
    : slot.allowedChoices).map(entry => ({ configurationId: slot.configurationId!, ...entry })));
  const catalogues = new Map<string, Extract<PluginExtensionItem, { kind: 'integration' }> | null>();
  // Fetch optional public toolkit metadata before local exact reads, so their
  // post-read checks also cover a permission/config change during catalogue IO.
  for (const { selection } of entries) if (selection.kind === 'composio') {
    const profileId = selection.target.kind === 'personal' ? selection.target.profileId : undefined;
    const key = JSON.stringify([selection.toolkit, profileId]);
    if (catalogues.has(key)) continue;
    try {
      const catalogue = await readAgentComposioOptionsCatalogue(context, AbortSignal.timeout(5_000),
        { search: selection.toolkit, selectedSlug: selection.toolkit, ...(profileId ? { profileId } : {}) });
      const item = catalogue.items.find(row => row.kind === 'integration' && row.toolkit.slug === selection.toolkit);
      catalogues.set(key, item?.kind === 'integration' ? item : null);
    } catch { catalogues.set(key, null); }
  }
  await revalidateAgentExtensionOptionsContext(context);
  let profiles = entries.some(entry => entry.selection.kind === 'composio' && entry.selection.target.kind === 'personal')
    ? await listExistingComposioProfiles(context.actor.userId) : [];
  const summaries: AgentExtensionStandaloneSummary[] = [];
  for (const entry of entries) {
    const { selection } = entry;
    const base = { configurationId: entry.configurationId, ...(entry.choiceId ? { choiceId: entry.choiceId } : {}), selection };
    if (selection.target.kind === 'shared') {
      const authorized = await authorizeAgentExtensionSharedOption(context, selection.target.connectionRef);
      if (!authorized.canUse || authorized.resource.source !== selection.source
        || authorized.resource.bindingRevision !== selection.target.bindingRevision
        || selection.kind === 'composio' && (authorized.backend.source !== 'composio' || authorized.backend.toolkit !== selection.toolkit)) continue;
      let icon: AgentExtensionStandaloneSummary['icon'];
      if (selection.kind === 'mcp') {
        const metadata = await readAgentSharedMcpOptionMetadata(context, selection.target.connectionRef).catch(() => null);
        // The image route requires actual actor Read; target-only Use never grants image access.
        const readable = await authorizeIntegrationConnection({ userId: context.actor.userId, organizationId: context.organizationId,
          workspaceId: context.actor.workspaceId }, selection.target.connectionRef, 'inspect').catch(() => null);
        if (metadata && readable?.access.canRead && (metadata.connection.url || metadata.connection.iconUrl)) {
          const resource = metadata.authorization.resource;
          icon = mcpPluginExtensionIcon(resource.connectionRef, mcpIconSourceBinding(resource.connectionRef, metadata.connection,
            `${resource.metadataRevision}:${resource.grantsRevision}:${resource.bindingRevision}`), context.actor.workspaceId);
        }
      } else icon = catalogues.get(JSON.stringify([selection.toolkit, undefined]))?.icon;
      summaries.push({ ...base, label: display(authorized.resource.displayName) || (selection.kind === 'composio' ? selection.toolkit : 'MCP'),
        scopeLabel: authorized.resource.ownership.type, ...(icon ? { icon } : {}) });
    } else if (selection.kind === 'mcp') {
      const metadata = await readAgentOwnMcpOptionMetadata(context, selection.target.connectionRef).catch(() => null);
      if (!metadata) continue;
      const icon = metadata.connection.url || metadata.connection.iconUrl ? mcpPluginExtensionIcon(selection.target.connectionRef,
        mcpIconSourceBinding(selection.target.connectionRef, metadata.connection), context.actor.workspaceId) : undefined;
      summaries.push({ ...base, label: display(metadata.connection.displayName) || display(metadata.serverName) || 'MCP',
        scopeLabel: 'personal', ...(icon ? { icon } : {}) });
    } else {
      const profileId = selection.target.profileId;
      const profile = profiles.find(row => row.id === profileId && row.ownerUserId === context.actor.userId && row.status === 'active');
      // No profile/name lookup for a foreign owner and no account-label guesses.
      if (!profile) continue;
      const toolkit = catalogues.get(JSON.stringify([selection.toolkit, selection.target.profileId]));
      summaries.push({ ...base, label: display(toolkit?.displayName) || selection.toolkit, scopeLabel: 'personal',
        ...(display(profile.name) ? { profileLabel: display(profile.name) } : {}), ...(toolkit?.icon ? { icon: toolkit.icon } : {}) });
    }
  }
  // Revalidate retained personal bindings after all optional metadata IO too.
  await projectAgentStandaloneConfigurations(context.actor, context.snapshot);
  profiles = profiles.length ? await listExistingComposioProfiles(context.actor.userId) : [];
  for (const summary of summaries) if (summary.selection.kind === 'composio' && summary.selection.target.kind === 'personal') {
    const profileId = summary.selection.target.profileId;
    const profile = profiles.find(row => row.id === profileId && row.ownerUserId === context.actor.userId && row.status === 'active');
    if (profile && display(profile.name)) summary.profileLabel = display(profile.name);
    else delete summary.profileLabel;
  }
  await revalidateAgentExtensionOptionsContext(context);
  return { slots, summaries };
}
