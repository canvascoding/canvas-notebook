import 'server-only';

import { listCapabilityResources } from '@/app/lib/capabilities/resources/actions';
import { findCapabilityResourceRecord, withAuthorizedCapabilityPackageResource } from '@/app/lib/capabilities/resources/store';
import { listCapabilityPackagePublishedRevisions } from '@/app/lib/capabilities/packages/store';
import { getPluginExtensionSearchDependencies, revalidateExtensions, searchPluginExtensions } from '@/app/lib/plugins/plugin-extension-search';
import type { PluginExtensionItem, PluginExtensionQuery } from '@/app/lib/plugins/plugin-extension-contracts';
import { AgentWorkflowError } from './workflow-contracts';
import { isIntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { EXTENSION_SELECTION_LIMITS } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentExtensionOptionsResponse, AgentExtensionSearchItem, AgentExtensionSearchRequest } from './extension-options-contracts';
import { authorizeExtensionSharedOption as authorizeAgentExtensionSharedOption, revalidateExtensionOptionsSourceContext as revalidateAgentExtensionOptionsContext, type ExtensionOptionsSourceContext } from './extension-options-source-context';
import type { AgentExtensionOptionsContext } from './extension-options-context';
import type { ChatExtensionOptionsContext } from '@/app/lib/chat/extension-options-context';
import type { ChatExtensionSearchRequest, ChatExtensionOptionsResponse } from '@/app/lib/chat/extension-options-contracts';
import { isChatExtensionOptionsContext } from '@/app/lib/chat/extension-options-context';
import { projectChatExtensionSearchItem } from '@/app/lib/chat/extension-options-eligibility';
import { readAgentComposioOptionsCatalogue, readAgentMcpOptionsInventory } from './extension-options-inventory';
import { readAgentExtensionPackageVersion } from './extension-package-options';
import { agentExtensionPackageIcon } from './extension-options-icons';

function innerCursor(context: ExtensionOptionsSourceContext, value: string | null): string | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (decoded.v !== 1 || decoded.context !== context.contextKey || typeof decoded.cursor !== 'string'
      || decoded.cursor.length > 8192 || Object.keys(decoded).length !== 3) throw new Error('invalid');
    return decoded.cursor;
  } catch { throw new AgentWorkflowError('AGENT_EXTENSION_CURSOR_INVALID', 'The selection context changed. Start the search again.', 400); }
}

/** Shared catalogue mechanics with a separate actual target-Use projection. No profile/account probes. */
async function searchExtensionMetadataOptions(context: ExtensionOptionsSourceContext,
  request: AgentExtensionSearchRequest | ChatExtensionSearchRequest, signal?: AbortSignal) {
  const resourceActor = { userId: context.actor.userId, workspaceId: context.actor.workspaceId };
  const defaults = await getPluginExtensionSearchDependencies();
  const { operation: _operation, target: _target, ...selection } = request;
  const query: PluginExtensionQuery = { ...selection, cursor: innerCursor(context, request.cursor) };
  const result = await searchPluginExtensions(context.actor, query, { signal, dependencies: { ...defaults,
    composio: (_actor, abort, options) => readAgentComposioOptionsCatalogue(context, abort, options),
    mcp: () => readAgentMcpOptionsInventory(context),
    revalidate: async (actor, items) => {
      const packages = await revalidateExtensions(actor, items.filter(item => item.kind === 'plugin' || item.kind === 'skill'));
      const retained = [...packages.items];
      const coverage = [...packages.coverage];
      // Refresh personal ownership/definition status through the same pure inventory.
      if (items.some(item => item.kind === 'mcp')) {
        const mcp = await readAgentMcpOptionsInventory(context), ids = new Set(items.filter(item => item.kind === 'mcp').map(item => item.id));
        retained.push(...mcp.items.filter(item => ids.has(item.id)));
        coverage.push(mcp.coverage);
      }
      // Do not turn catalogue metadata into account observations. Recheck exact
      // shared grants after all remote catalogue IO before retaining a row.
      for (const item of items) if (item.kind === 'integration') {
        const connections: typeof item.connections = [];
        for (const previous of item.connections) {
          try {
            const fresh = await authorizeAgentExtensionSharedOption(context, previous.connectionRef);
            if (fresh.backend.source !== 'composio' || fresh.backend.toolkit !== item.toolkit.slug) continue;
            connections.push({ ...previous, displayName: fresh.resource.displayName,
              ownership: fresh.resource.ownership, access: { canRead: true, canUse: fresh.canUse, canManage: fresh.canManage },
              authorization: 'unknown', health: 'unknown', enabled: fresh.resource.status === 'active' });
          } catch (error) { if (!isIntegrationConnectionError(error) || ![403, 404].includes(error.status)) throw error; }
        }
        retained.push({ ...item, connections });
      }
      await revalidateAgentExtensionOptionsContext(context);
      return { items: retained, coverage };
    },
  } });
  const resources = new Map((await listCapabilityResources(resourceActor)).map(value => [value.metadata.resourceRef, value]));
  async function project(item: PluginExtensionItem): Promise<AgentExtensionSearchItem> {
    if (item.kind === 'integration') return { item, eligibility: { action: 'choose_connection' } };
    if (item.kind === 'mcp') {
      if (item.mcp.template || !item.connections.length) return { item, eligibility: { action: 'setup' } };
      const connection = item.connections[0];
      if (!connection.access.canUse || !connection.enabled || connection.ownership.type === 'user' && !context.allowPersonal) {
        return { item, eligibility: { action: 'unavailable', reason: { code: 'AGENT_EXTENSION_USE_DENIED',
          message: 'This exact connection is not available as a fixed connection for this agent.' } } };
      }
      // Shared binding revisions are obtained in the explicit chooser. Never
      // reconstruct them from the public catalogue connection DTO.
      return { item, eligibility: { action: 'choose_connection' } };
    }
    if (!item.package) return { item, eligibility: { action: 'setup' } };
    const resource = resources.get(item.package.resourceRef);
    if (!resource?.access.canUse || resource.metadata.status !== 'active' || resource.activation?.effectivePolicy === 'blocked'
      || resource.activation?.readiness === 'conflict' || !context.allowPersonal && resource.artifact.scopeType === 'user') {
      return { item, eligibility: { action: 'unavailable', reason: { code: 'AGENT_EXTENSION_USE_DENIED', message: 'Current package use is required for this agent.' } } };
    }
    // Plugin children are selected from the actual held parent's child inventory.
    // A child display row is never treated as an independent package pin.
    const reference = item.package.parentResourceRef || resource.metadata.resourceRef;
    const record = await findCapabilityResourceRecord(reference);
    if (!record || resource.artifact.sourceType === 'plugin' && !item.package.parentResourceRef) return { item, eligibility: { action: 'unavailable', reason: {
      code: 'AGENT_EXTENSION_PARENT_SELECTION_REQUIRED', message: 'Open the parent plugin and choose this exact child from its published version.' } } };
    let versions: Awaited<ReturnType<typeof listCapabilityPackagePublishedRevisions>>;
    try { versions = await withAuthorizedCapabilityPackageResource(resourceActor, record.storage, 'use', undefined,
      async (authorization, database) => listCapabilityPackagePublishedRevisions(authorization.record.metadata.resourceRef, database)); }
    catch { return { item, eligibility: { action: 'unavailable', reason: { code: 'AGENT_EXTENSION_PACKAGE_UNAVAILABLE', message: 'This package version is no longer available.' } } }; }
    if (!versions.length) return { item, eligibility: { action: 'setup', reason: { code: 'AGENT_EXTENSION_PUBLISH_REQUIRED', message: 'Publish this package before selecting it.' } } };
    const publishedVersions = versions.map(version => ({ pin: { resourceRef: reference,
      publishedRevisionRef: version.revisionRef, checksum: version.checksum }, version: version.version, publishedAt: version.publishedAt }));
    if (resource.artifact.sourceType === 'plugin') {
      const selected = publishedVersions.find(version => version.version === resources.get(reference)?.artifact.version) ?? publishedVersions[0];
      const parent = await readAgentExtensionPackageVersion(resourceActor, selected.pin, { allowPersonalPackages: context.allowPersonal });
      const child = parent.metadata.skillRoots.find(skill => skill.name === resource.artifact.name);
      if (parent.metadata.kind !== 'plugin' || !child || record.storage.resourceId !== resource.artifact.sourcePluginId) {
        return { item, eligibility: { action: 'unavailable', reason: { code: 'AGENT_EXTENSION_PARENT_SELECTION_REQUIRED',
          message: 'Choose this child from its actual published parent version.' } } };
      }
      const skill = parent.source.skills.find(skill => skill.relativeRoot === child.relativeRoot)?.skill;
      return { item: { ...item, icon: agentExtensionPackageIcon(selected.pin, [skill?.interface?.iconSmall, skill?.interface?.iconLarge],
        context.actor.workspaceId, child.relativeRoot) }, publishedVersions, selection: { kind: 'skill', origin: 'plugin_child',
        relativeRoot: child.relativeRoot, package: selected.pin }, eligibility: { action: 'select' } };
    }
    return { item, publishedVersions, eligibility: { action: 'select' } };
  }
  let items = await Promise.all(result.items.map(project));
  let selectedItem = result.selectedItem ? await project(result.selectedItem) : null;
  if (isChatExtensionOptionsContext(context)) {
    items = await Promise.all(items.map(item => projectChatExtensionSearchItem(context, item)));
    if (selectedItem) selectedItem = await projectChatExtensionSearchItem(context, selectedItem);
  }
  await revalidateAgentExtensionOptionsContext(context);
  const nextCursor = result.pagination.nextCursor ? Buffer.from(JSON.stringify({ v: 1, context: context.contextKey,
    cursor: result.pagination.nextCursor })).toString('base64url') : null;
  if (nextCursor && nextCursor.length > 8192) throw new AgentWorkflowError('AGENT_EXTENSION_CURSOR_INVALID', 'Narrow this catalogue search before loading further pages.', 400);
  return { schemaVersion: 1, operation: 'search', target: request.target, contextKey: context.contextKey,
    coverage: result.coverage, limits: EXTENSION_SELECTION_LIMITS, query: request, items, selectedItem,
    scopes: result.scopes, pagination: { ...result.pagination, nextCursor } };
}

export async function searchAgentExtensionOptions(context: AgentExtensionOptionsContext, request: AgentExtensionSearchRequest, signal?: AbortSignal): Promise<Extract<AgentExtensionOptionsResponse, { operation: 'search' }>> {
  return await searchExtensionMetadataOptions(context, request, signal) as Extract<AgentExtensionOptionsResponse, { operation: 'search' }>;
}
export async function searchChatExtensionOptions(context: ChatExtensionOptionsContext, request: ChatExtensionSearchRequest, signal?: AbortSignal) {
  return await searchExtensionMetadataOptions(context, request, signal) as Omit<Extract<ChatExtensionOptionsResponse, { operation: 'search' }>, 'recents' | 'agentRevision' | 'workflowRevision' | 'preferenceRevision' | 'finalSendValidationRequired'>;
}
