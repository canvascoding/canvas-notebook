import 'server-only';

import { CapabilityResourceError, type CapabilityResourceActor, type CapabilityResourceDescriptor, type CapabilityResourceOwnerScope } from '@/app/lib/capabilities/resources/contracts';
import {
  PLUGIN_WORKSPACE_CATALOG_DEFAULT_LIMIT, PLUGIN_WORKSPACE_CATALOG_MAX_LIMIT,
  PLUGIN_WORKSPACE_CATALOG_MAX_TEAM_CHOICES, PLUGIN_WORKSPACE_CATALOG_SCHEMA_VERSION,
  type PluginWorkspaceCatalogItem, type PluginWorkspaceCatalogQuery, type PluginWorkspaceCatalogResponse,
  type PluginWorkspaceCatalogScope, type PluginWorkspaceCatalogScopeContext,
} from './plugin-workspace-catalog-contracts';
import { resolvePluginWorkspaceCatalogScopeContext, selectPluginWorkspaceItems } from './plugin-workspace-selection';
import { installedPluginExtensionIcon } from './plugin-extension-icons';

function invalidQuery(): never {
  throw new CapabilityResourceError('PLUGIN_CATALOG_QUERY_INVALID', 'The catalog query does not match the supported fields.', 400);
}

function identity(value: unknown, maximum = 200): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CapabilityResourceError('PLUGIN_CATALOG_UNAVAILABLE', 'Installed resource metadata is currently unavailable.', 503);
  }
  return value;
}

function label(value: unknown, maximum = 200): string | null {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, maximum) || null
    : null;
}

/** Workspace is context transport only; authentication supplies the actor. */
export function parsePluginWorkspaceCatalogQuery(parameters: URLSearchParams): PluginWorkspaceCatalogQuery {
  const permitted = new Set(['kind', 'scope', 'audience', 'teamId', 'q', 'page', 'limit', 'workspaceId']);
  for (const key of parameters.keys()) if (!permitted.has(key) || parameters.getAll(key).length !== 1) return invalidQuery();
  const scope = parameters.get('scope') ?? 'all';
  if (!['all', 'user', 'team', 'organization', 'system'].includes(scope)) return invalidQuery();
  const kind = parameters.get('kind');
  if (kind !== null && kind !== 'plugin' && kind !== 'skill') return invalidQuery();
  const audience = parameters.get('audience');
  if (audience !== null && (scope !== 'user' || !['own', 'shared'].includes(audience))) return invalidQuery();
  const teamId = parameters.get('teamId');
  if (teamId !== null && (scope !== 'team' || !teamId || teamId.trim() !== teamId || teamId.length > 200 || /[\u0000-\u001f\u007f]/u.test(teamId))) return invalidQuery();
  const workspace = parameters.get('workspaceId');
  if (workspace !== null && (!workspace || workspace.trim() !== workspace || workspace.length > 200 || /[\u0000-\u001f\u007f]/u.test(workspace))) return invalidQuery();
  const q = parameters.get('q') ?? '';
  if (q.length > 512 || /[\u0000-\u001f\u007f]/u.test(q)) return invalidQuery();
  const positiveInteger = (key: string, fallback: number, maximum: number): number => {
    const raw = parameters.get(key);
    if (raw === null) return fallback;
    if (!/^[1-9]\d{0,5}$/u.test(raw)) return invalidQuery();
    const value = Number(raw);
    if (value > maximum) return invalidQuery();
    return value;
  };
  return { scope: scope as PluginWorkspaceCatalogScope, kind, audience: scope === 'user' ? (audience as 'own' | 'shared' | null) ?? 'own' : null,
    teamId, q: q.trim(), page: positiveInteger('page', 1, 100000), limit: positiveInteger('limit', PLUGIN_WORKSPACE_CATALOG_DEFAULT_LIMIT, PLUGIN_WORKSPACE_CATALOG_MAX_LIMIT) };
}

function publicOwnership(owner: CapabilityResourceOwnerScope): CapabilityResourceOwnerScope {
  if (owner.type === 'system') return { type: 'system' };
  if (owner.type === 'user') return { type: 'user', ownerUserId: identity(owner.ownerUserId), organizationId: owner.organizationId === null ? null : identity(owner.organizationId) };
  if (owner.type === 'organization') return { type: 'organization', organizationId: identity(owner.organizationId) };
  if (owner.type === 'team') return { type: 'team', organizationId: identity(owner.organizationId), workspaceId: identity(owner.workspaceId) };
  throw new CapabilityResourceError('PLUGIN_CATALOG_UNAVAILABLE', 'Installed resource metadata is currently unavailable.', 503);
}

function publicItem(resource: CapabilityResourceDescriptor, parents: ReadonlyMap<string, string | null>, workspaceId?: string | null): PluginWorkspaceCatalogItem {
  const name = identity(resource.artifact.name);
  if (!['plugin', 'skill'].includes(resource.artifact.resourceType) || !Number.isSafeInteger(resource.artifact.revision) || resource.artifact.revision < 0) {
    throw new CapabilityResourceError('PLUGIN_CATALOG_UNAVAILABLE', 'Installed resource metadata is currently unavailable.', 503);
  }
  const item: PluginWorkspaceCatalogItem = { resourceRef: identity(resource.metadata.resourceRef, 2048), legacyResourceId: identity(resource.artifact.resourceId, 2048),
    kind: resource.artifact.resourceType, name, displayName: label(resource.metadata.displayName) ?? label(name) ?? name,
    description: label(resource.metadata.description ?? resource.description, 4096) ?? '', version: identity(resource.artifact.version, 200), revision: resource.artifact.revision,
    icon: installedPluginExtensionIcon(resource.metadata.resourceRef, resource.artifact.revision, workspaceId),
    ownership: publicOwnership(resource.metadata.ownership), access: { canRead: resource.access.canRead === true, canUse: resource.access.canUse === true,
      canEdit: resource.access.canEdit === true, canManage: resource.access.canManage === true } };
  const ownershipLabel = label(resource.ownershipLabel);
  if (ownershipLabel) item.ownershipLabel = ownershipLabel;
  if (resource.activation) item.activation = { effectivePolicy: resource.activation.effectivePolicy, enabled: resource.activation.enabled === true,
    readiness: resource.activation.readiness, blockedReason: label(resource.activation.blockedReason, 512) };
  if (resource.people) {
    const people: NonNullable<PluginWorkspaceCatalogItem['people']> = {};
    for (const role of ['owner', 'createdBy', 'updatedBy', 'responsible'] as const) {
      const person = resource.people[role];
      if (person) people[role] = { name: label(person.name) };
    }
    if (Object.keys(people).length) item.people = people;
  }
  if (resource.artifact.resourceType === 'skill' && resource.artifact.sourceType === 'plugin' && resource.artifact.sourcePluginId) {
    const parent = parents.get(resource.artifact.sourcePluginId);
    if (parent) item.parentResourceRef = identity(parent, 2048);
  }
  return item;
}

function catalogSelection(resources: readonly CapabilityResourceDescriptor[], context: PluginWorkspaceCatalogScopeContext,
  query: PluginWorkspaceCatalogQuery) {
  // Reparse even server callers so malformed pagination cannot widen a public result.
  const parameters = new URLSearchParams({ scope: query.scope, q: query.q, page: String(query.page), limit: String(query.limit) });
  if (query.kind !== null) parameters.set('kind', query.kind);
  if (query.audience !== null) parameters.set('audience', query.audience);
  if (query.teamId !== null) parameters.set('teamId', query.teamId);
  const selection = parsePluginWorkspaceCatalogQuery(parameters);
  if (selection.scope === 'team' && selection.teamId && !context.readableTeamIds.has(selection.teamId)) {
    throw new CapabilityResourceError('PLUGIN_CATALOG_TEAM_NOT_FOUND', 'The selected team is unavailable in this context.', 404);
  }
  const readable = resources.filter(resource => resource.access.canRead === true && resource.metadata.status === 'active');
  const parents = new Map<string, string | null>();
  for (const resource of readable) if (resource.artifact.resourceType === 'plugin') {
    const id = resource.artifact.resourceId;
    parents.set(id, parents.has(id) && parents.get(id) !== resource.metadata.resourceRef ? null : resource.metadata.resourceRef);
  }
  const exactItems = new Map<string, PluginWorkspaceCatalogItem>();
  for (const resource of readable) {
    const item = publicItem(resource, parents, context.workspaceId), existing = exactItems.get(item.resourceRef);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
      throw new CapabilityResourceError('PLUGIN_CATALOG_UNAVAILABLE', 'Installed resource metadata is currently unavailable.', 503);
    }
    if (!existing) exactItems.set(item.resourceRef, item);
  }
  const selected = selectPluginWorkspaceItems([...exactItems.values()], context, selection);
  const choices: PluginWorkspaceCatalogScope[] = ['all', 'user'];
  if (context.readableTeamIds.size) choices.push('team');
  if (context.organizationAvailable) choices.push('organization');
  if (readable.some(resource => resource.metadata.ownership.type === 'system')) choices.push('system');
  return { selection: { ...selection, selectionRequired: selection.scope === 'team' && !selection.teamId ? 'team' as const : null },
    items: selected, scopes: { choices, teams: context.teams.filter(team => context.readableTeamIds.has(team.teamId))
      .slice(0, PLUGIN_WORKSPACE_CATALOG_MAX_TEAM_CHOICES).map(team => ({ teamId: identity(team.teamId), label: label(team.label) ?? 'Team' })) } };
}

/** Shared exact selection; contains private descriptors only for trusted server consumers. */
export function selectPluginWorkspaceCatalogResources(resources: readonly CapabilityResourceDescriptor[], context: PluginWorkspaceCatalogScopeContext,
  query: PluginWorkspaceCatalogQuery): CapabilityResourceDescriptor[] {
  const selection = catalogSelection(resources, context, query), byRef = new Map(resources.map(resource => [resource.metadata.resourceRef, resource]));
  return selection.items.map(item => byRef.get(item.resourceRef)!);
}

/** A management projection preserves exact instances, including readable shadowed installations. */
export function projectPluginWorkspaceCatalog(resources: readonly CapabilityResourceDescriptor[], context: PluginWorkspaceCatalogScopeContext,
  query: PluginWorkspaceCatalogQuery): PluginWorkspaceCatalogResponse {
  const { selection, items, scopes } = catalogSelection(resources, context, query);
  const totalItems = items.length, totalPages = Math.ceil(totalItems / selection.limit), start = (selection.page - 1) * selection.limit;
  return { schemaVersion: PLUGIN_WORKSPACE_CATALOG_SCHEMA_VERSION, selection, items: items.slice(start, start + selection.limit), scopes,
    pagination: { page: selection.page, limit: selection.limit, totalItems, totalPages, hasNextPage: selection.page < totalPages, hasPreviousPage: selection.page > 1 && totalItems > 0 } };
}

export async function listPluginWorkspaceCatalog(input: CapabilityResourceActor, query: PluginWorkspaceCatalogQuery): Promise<PluginWorkspaceCatalogResponse> {
  const actor: CapabilityResourceActor = { userId: input.userId, workspaceId: input.workspaceId?.trim() || null };
  const context = await resolvePluginWorkspaceCatalogScopeContext(actor);
  // Scope selection is checked before catalog loading, including nonexistent/unreadable teams.
  projectPluginWorkspaceCatalog([], context, query);
  const { listCapabilityResources } = await import('@/app/lib/capabilities/resources/actions');
  const resources = await listCapabilityResources(actor);
  return projectPluginWorkspaceCatalog(resources, await resolvePluginWorkspaceCatalogScopeContext(actor), query);
}
