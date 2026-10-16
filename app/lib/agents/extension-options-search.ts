import 'server-only';
import { observeExtensionStage } from '@/app/lib/plugins/extension-search-observation';

import { listCapabilityResources } from '@/app/lib/capabilities/resources/actions';
import { findCapabilityResourceRecord, withAuthorizedCapabilityPackageResource } from '@/app/lib/capabilities/resources/store';
import { listCapabilityPackagePublishedRevisions } from '@/app/lib/capabilities/packages/store';
import { getPluginExtensionSearchDependencies, getPluginExtensionSearchResourceSnapshot, revalidateExtensions, searchPluginExtensions } from '@/app/lib/plugins/plugin-extension-search';
import type { PluginExtensionItem, PluginExtensionQuery } from '@/app/lib/plugins/plugin-extension-contracts';
import { AgentWorkflowError } from './workflow-contracts';
import { isIntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { EXTENSION_SELECTION_LIMITS } from '@/app/lib/capabilities/extensions/contracts';
import { corePluginSource, withAuthorizedCorePluginSource, loadCoreSkillSource, withAuthorizedCoreSkillSource } from '@/app/lib/capabilities/extensions/core-source';
import { loadCoreCanvasPlugin } from '@/app/lib/plugins/core-plugin-loader';
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
      return { items: retained, coverage, resources: packages.resources };
    },
  } });
  const hasPackages = [...result.items, ...(result.selectedItem ? [result.selectedItem] : [])]
    .some(item => (item.kind === 'plugin' || item.kind === 'skill') && item.package);
  const resources = new Map((hasPackages ? getPluginExtensionSearchResourceSnapshot(result, resourceActor)
    ?? await listCapabilityResources(resourceActor) : []).map(value => [value.metadata.resourceRef, value]));
  // One exact immutable source per pin in this response, never an authorization
  // cache across searches, actors, or the final Preview/Send lifecycle.
  const packageSources = new Map<string, ReturnType<typeof readAgentExtensionPackageVersion>>();
  const packageVersion = (pin: Parameters<typeof readAgentExtensionPackageVersion>[1]) => {
    const key = JSON.stringify(pin);
    let value = packageSources.get(key);
    if (!value) { value = observeExtensionStage('package_source', () => readAgentExtensionPackageVersion(resourceActor, pin, { allowPersonalPackages: context.allowPersonal })); packageSources.set(key, value); }
    return value;
  };
  const publishedPackages = new Map<string, ReturnType<typeof readPublishedPackage>>();
  async function readPublishedPackage(reference: string) {
    const record = await findCapabilityResourceRecord(reference);
    if (!record) return null;
    const versions = await withAuthorizedCapabilityPackageResource(resourceActor, record.storage, 'use', undefined,
      async (authorization, database) => listCapabilityPackagePublishedRevisions(authorization.record.metadata.resourceRef, database));
    return { record, versions };
  }
  const publishedPackage = (reference: string) => {
    let value = publishedPackages.get(reference);
    if (!value) { value = readPublishedPackage(reference); publishedPackages.set(reference, value); }
    return value;
  };
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
    if(resource.artifact.resourceType==='plugin' && resource.artifact.sourceType==='core' && resource.artifact.scopeType==='system') {
      const plugin=await loadCoreCanvasPlugin(resource.artifact.name);
      if(!plugin || plugin.resourceId!==resource.artifact.resourceId) return {item,eligibility:{action:'unavailable',reason:{
        code:'AGENT_EXTENSION_PACKAGE_UNAVAILABLE',message:'The current built-in plugin source is unavailable.'}}};
      const source=corePluginSource(plugin);
      await withAuthorizedCorePluginSource(resourceActor,source,async()=>undefined);
      return {item,selection:{kind:'core_plugin',coreSource:source},eligibility:{action:'select'}};
    }
    if (resource.artifact.resourceType === 'skill' && resource.artifact.sourceType === 'core' && resource.artifact.scopeType === 'system') {
      const { source } = await loadCoreSkillSource(resource.artifact.name);
      if (source.resourceRef !== resource.artifact.resourceId) throw new AgentWorkflowError('AGENT_EXTENSION_PACKAGE_UNAVAILABLE', 'The exact Core skill source changed.', 409);
      await withAuthorizedCoreSkillSource(resourceActor, source, async () => undefined);
      return { item, selection: { kind: 'core_skill', coreSource: source }, eligibility: { action: 'select' } };
    }
    // Plugin children are selected from the actual held parent's child inventory.
    // A child display row is never treated as an independent package pin.
    const reference = item.package.parentResourceRef || resource.metadata.resourceRef;
    if (resource.artifact.sourceType === 'plugin' && !item.package.parentResourceRef) return { item, eligibility: { action: 'unavailable', reason: {
      code: 'AGENT_EXTENSION_PARENT_SELECTION_REQUIRED', message: 'Open the parent plugin and choose this exact child from its published version.' } } };
    let published;
    try { published = await publishedPackage(reference); }
    catch { return { item, eligibility: { action: 'unavailable', reason: { code: 'AGENT_EXTENSION_PACKAGE_UNAVAILABLE', message: 'This package version is no longer available.' } } }; }
    if (!published) return { item, eligibility: { action: 'setup', reason: resource.artifact.sourceType === 'plugin' ? {
      code: 'AGENT_EXTENSION_PARENT_SELECTION_REQUIRED', message: 'Open the parent plugin and choose this exact child from its published version.' }
      : { code: 'AGENT_EXTENSION_PUBLISH_REQUIRED', message: 'Publish this package before selecting it.' } } };
    const { record, versions } = published;
    if (!versions.length) return { item, eligibility: { action: 'setup', reason: { code: 'AGENT_EXTENSION_PUBLISH_REQUIRED', message: 'Publish this package before selecting it.' } } };
    const publishedVersions = versions.map(version => ({ pin: { resourceRef: reference,
      publishedRevisionRef: version.revisionRef, checksum: version.checksum }, version: version.version, publishedAt: version.publishedAt }));
    if (resource.artifact.sourceType === 'plugin') {
      const selected = publishedVersions.find(version => version.version === resources.get(reference)?.artifact.version) ?? publishedVersions[0];
      const actualParent = resources.get(reference);
      // The resource catalog has just parsed this exact installed parent. Its
      // verified pointer matches the immutable published checksum. Search can
      // expose that child identity without revalidating every byte for every
      // sibling. Preview/Send still read and authorize the exact held package.
      if (resource.artifact.pluginSkillRelativeRoot !== undefined && actualParent?.artifact.sourceType !== 'plugin'
        && actualParent?.artifact.version === selected.version && actualParent.artifact.checksum === selected.pin.checksum
        && record.storage.resourceId === resource.artifact.sourcePluginId) {
        return { item, publishedVersions, selection: { kind: 'skill', origin: 'plugin_child',
          relativeRoot: resource.artifact.pluginSkillRelativeRoot, package: selected.pin }, eligibility: { action: 'select' } };
      }
      const parent = await packageVersion(selected.pin);
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
  let items = await observeExtensionStage('projection', () => Promise.all(result.items.map(project)), values => values.length);
  let selectedItem = result.selectedItem ? await project(result.selectedItem) : null;
  if (isChatExtensionOptionsContext(context)) {
    items = await observeExtensionStage('projection', () => Promise.all(items.map(item => projectChatExtensionSearchItem(context, item, { resources, packageVersion }))), values => values.length);
    if (selectedItem) selectedItem = await projectChatExtensionSearchItem(context, selectedItem, { resources, packageVersion });
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
