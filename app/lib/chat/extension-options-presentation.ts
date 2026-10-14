import 'server-only';
import { createHash } from 'node:crypto';
import { authorizeIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { listExistingComposioProfiles } from '@/app/lib/composio/composio-profiles';
import { readAgentComposioOptionsCatalogue, readAgentOwnMcpOptionMetadata, readAgentSharedMcpOptionMetadata } from '@/app/lib/agents/extension-options-inventory';
import { readAgentExtensionPackageVersion } from '@/app/lib/agents/extension-package-options';
import { agentExtensionPackageIcon } from '@/app/lib/agents/extension-options-icons';
import { mcpIconSourceBinding } from '@/app/lib/mcp/icon-source';
import { mcpPluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import type { PluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import type { ExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import { authorizeChatExtensionSharedOption, revalidateChatExtensionOptionsContext, type ChatExtensionOptionsContext } from './extension-options-context';

/** Historical presentation reads the exact identity; absence is initials, never a replacement selection. */
export async function presentChatExtensionIcon(context: ChatExtensionOptionsContext, selection: ExtensionSelection,
  signal: AbortSignal): Promise<PluginExtensionIcon | undefined> {
  await revalidateChatExtensionOptionsContext(context);
  let icon: PluginExtensionIcon | undefined;
  if (selection.kind === 'plugin' || selection.kind === 'skill') {
    const source = await readAgentExtensionPackageVersion({ userId: context.actor.userId, workspaceId: context.actor.workspaceId }, selection.package, { allowPersonalPackages: true });
    if (selection.kind === 'plugin' && source.metadata.kind !== 'plugin' || selection.kind === 'skill'
      && (selection.origin === 'plugin_child' ? source.metadata.kind !== 'plugin' : source.metadata.kind !== 'skill')) return;
    const child = selection.kind === 'skill' ? source.source.skills.find(value => value.relativeRoot === selection.relativeRoot)?.skill : undefined;
    if (selection.kind === 'skill' && !child) return;
    icon = agentExtensionPackageIcon(selection.package, selection.kind === 'plugin'
      ? [source.source.manifest?.interface?.logo, source.source.manifest?.interface?.icon]
      : [child?.interface?.iconSmall, child?.interface?.iconLarge], context.actor.workspaceId,
    selection.kind === 'skill' ? selection.relativeRoot : undefined);
  } else if (selection.kind === 'mcp') {
    if (selection.target.kind === 'personal') {
      const metadata = await readAgentOwnMcpOptionMetadata(context, selection.target.connectionRef);
      if (metadata && (metadata.connection.url || metadata.connection.iconUrl)) icon = mcpPluginExtensionIcon(selection.target.connectionRef,
        mcpIconSourceBinding(selection.target.connectionRef, metadata.connection), context.actor.workspaceId);
    } else {
      const authorized = await authorizeChatExtensionSharedOption(context, selection.target.connectionRef);
      if (authorized.backend.source !== 'mcp' || authorized.resource.bindingRevision !== selection.target.bindingRevision) return;
      // Image authorization remains human Read, even when target-only Use is allowed.
      const readable = await authorizeIntegrationConnection({ userId: context.actor.userId, organizationId: context.organizationId,
        workspaceId: context.actor.workspaceId }, selection.target.connectionRef, 'inspect');
      const metadata = readable.access.canRead ? await readAgentSharedMcpOptionMetadata(context, selection.target.connectionRef) : null;
      if (metadata && (metadata.connection.url || metadata.connection.iconUrl)) icon = mcpPluginExtensionIcon(selection.target.connectionRef,
        mcpIconSourceBinding(selection.target.connectionRef, metadata.connection,
          `${authorized.resource.metadataRevision}:${authorized.resource.grantsRevision}:${authorized.resource.bindingRevision}`), context.actor.workspaceId);
    }
  } else {
    if (selection.target.kind === 'shared') {
      const authorized = await authorizeChatExtensionSharedOption(context, selection.target.connectionRef);
      if (authorized.backend.source !== 'composio' || authorized.backend.toolkit !== selection.toolkit
        || authorized.resource.bindingRevision !== selection.target.bindingRevision) return;
    } else {
      const profileId = selection.target.profileId;
      if (!(await listExistingComposioProfiles(context.actor.userId)).some(profile => profile.id === profileId
        && profile.ownerUserId === context.actor.userId && profile.status === 'active')) return;
    }
    const catalogue = await readAgentComposioOptionsCatalogue(context, signal, { search: selection.toolkit, selectedSlug: selection.toolkit,
      ...(selection.target.kind === 'personal' ? { profileId: selection.target.profileId } : {}) });
    icon = catalogue.items.find(item => item.kind === 'integration' && item.toolkit.slug === selection.toolkit)?.icon;
  }
  await revalidateChatExtensionOptionsContext(context);
  // No caption/account/endpoint in a source key, but exact pin and actor namespace remain bound.
  return icon ? { url: icon.url, sourceKey: `chat-icon:${createHash('sha256').update(JSON.stringify([
    context.actor.userId, context.actor.workspaceId, selection, icon.sourceKey])).digest('base64url')}` } : undefined;
}
