import 'server-only';

import { openDb } from '@/app/lib/db';
import { authority } from '@/app/lib/capabilities/scope-authority';
import { CapabilityResourceError, type CapabilityResourceActor, type CapabilityResourceDescriptor, type CapabilityResourceOwnerScope } from '@/app/lib/capabilities/resources/contracts';
import {
  PLUGIN_WORKSPACE_CATALOG_DEFAULT_LIMIT, PLUGIN_WORKSPACE_CATALOG_MAX_LIMIT,
  PLUGIN_WORKSPACE_CATALOG_MAX_TEAM_CHOICES, PLUGIN_WORKSPACE_CATALOG_SCHEMA_VERSION,
  type PluginWorkspaceCatalogItem, type PluginWorkspaceCatalogQuery, type PluginWorkspaceCatalogResponse,
  type PluginWorkspaceCatalogScope, type PluginWorkspaceCatalogScopeContext,
} from './plugin-workspace-catalog-contracts';

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

function publicItem(resource: CapabilityResourceDescriptor, parents: ReadonlyMap<string, string | null>): PluginWorkspaceCatalogItem {
  const name = identity(resource.artifact.name);
  if (!['plugin', 'skill'].includes(resource.artifact.resourceType) || !Number.isSafeInteger(resource.artifact.revision) || resource.artifact.revision < 0) {
    throw new CapabilityResourceError('PLUGIN_CATALOG_UNAVAILABLE', 'Installed resource metadata is currently unavailable.', 503);
  }
  const item: PluginWorkspaceCatalogItem = { resourceRef: identity(resource.metadata.resourceRef, 2048), legacyResourceId: identity(resource.artifact.resourceId, 2048),
    kind: resource.artifact.resourceType, name, displayName: label(resource.metadata.displayName) ?? label(name) ?? name,
    description: label(resource.metadata.description ?? resource.description, 4096) ?? '', version: identity(resource.artifact.version, 200), revision: resource.artifact.revision,
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

/** A management projection preserves exact instances, including readable shadowed installations. */
export function projectPluginWorkspaceCatalog(resources: readonly CapabilityResourceDescriptor[], context: PluginWorkspaceCatalogScopeContext,
  query: PluginWorkspaceCatalogQuery): PluginWorkspaceCatalogResponse {
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
    const item = publicItem(resource, parents), existing = exactItems.get(item.resourceRef);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
      throw new CapabilityResourceError('PLUGIN_CATALOG_UNAVAILABLE', 'Installed resource metadata is currently unavailable.', 503);
    }
    if (!existing) exactItems.set(item.resourceRef, item);
  }
  const search = selection.q.toLocaleLowerCase('en-US');
  const selected = selection.scope === 'team' && !selection.teamId ? [] : [...exactItems.values()].filter(item => {
    if (selection.kind && item.kind !== selection.kind) return false;
    const owner = item.ownership;
    if (selection.scope === 'user') {
      const own = owner.type === 'user' && owner.ownerUserId === context.actorUserId;
      if (selection.audience === 'own' ? !own : own || owner.type === 'system') return false;
    } else if (selection.scope === 'team' && (owner.type !== 'team' || owner.workspaceId !== selection.teamId)) return false;
    else if (selection.scope === 'organization' && owner.type !== 'organization') return false;
    else if (selection.scope === 'system' && owner.type !== 'system') return false;
    return !search || [item.name, item.displayName, item.description, item.ownershipLabel ?? ''].some(value => value.toLocaleLowerCase('en-US').includes(search));
  }).sort((left, right) => {
    const leftName = left.displayName.toLocaleLowerCase('en-US');
    const rightName = right.displayName.toLocaleLowerCase('en-US');
    return leftName < rightName ? -1 : leftName > rightName ? 1 : left.resourceRef < right.resourceRef ? -1 : left.resourceRef > right.resourceRef ? 1 : 0;
  });
  const totalItems = selected.length;
  const totalPages = Math.ceil(totalItems / selection.limit);
  const start = (selection.page - 1) * selection.limit;
  const choices: PluginWorkspaceCatalogScope[] = ['all', 'user'];
  if (context.readableTeamIds.size) choices.push('team');
  if (context.organizationAvailable) choices.push('organization');
  if (readable.some(resource => resource.metadata.ownership.type === 'system')) choices.push('system');
  return { schemaVersion: PLUGIN_WORKSPACE_CATALOG_SCHEMA_VERSION, selection: { ...selection, selectionRequired: selection.scope === 'team' && !selection.teamId ? 'team' : null },
    items: selected.slice(start, start + selection.limit), scopes: { choices, teams: context.teams.filter(team => context.readableTeamIds.has(team.teamId))
      .slice(0, PLUGIN_WORKSPACE_CATALOG_MAX_TEAM_CHOICES).map(team => ({ teamId: identity(team.teamId), label: label(team.label) ?? 'Team' })) },
    pagination: { page: selection.page, limit: selection.limit, totalItems, totalPages, hasNextPage: selection.page < totalPages, hasPreviousPage: selection.page > 1 && totalItems > 0 } };
}

export async function listPluginWorkspaceCatalog(input: CapabilityResourceActor, query: PluginWorkspaceCatalogQuery): Promise<PluginWorkspaceCatalogResponse> {
  const actor: CapabilityResourceActor = { userId: input.userId, workspaceId: input.workspaceId?.trim() || null };
  if (!actor.userId || actor.userId.length > 200 || /[\u0000-\u001f\u007f]/u.test(actor.userId)
    || actor.workspaceId && (actor.workspaceId.length > 200 || /[\u0000-\u001f\u007f]/u.test(actor.workspaceId))) return invalidQuery();
  const database = await openDb();
  let context: PluginWorkspaceCatalogScopeContext;
  try {
    const current = await authority(database, actor);
    if (!current.valid || !current.contextValid) throw new CapabilityResourceError('PLUGIN_CATALOG_ACCESS_DENIED', 'This catalog context is unavailable.', 403);
    const readableTeamIds = new Set([...current.workspaces.values()].filter(workspace => workspace.type === 'team' && workspace.status === 'active' && workspace.canRead).map(workspace => workspace.id));
    // Fetch labels only for IDs already authorized by the shared scope service.
    const ids = [...readableTeamIds].sort().slice(0, PLUGIN_WORKSPACE_CATALOG_MAX_TEAM_CHOICES);
    const rows = ids.length ? await database.all(`SELECT id, display_name FROM canvas_workspaces WHERE id IN (${ids.map((_, index) => `$${index + 1}`).join(',')}) AND type='team' AND status='active' ORDER BY lower(display_name), id LIMIT ${PLUGIN_WORKSPACE_CATALOG_MAX_TEAM_CHOICES}`, ids) as Array<{ id: string; display_name: unknown }> : [];
    const configured = await database.get('SELECT organization_id FROM canvas_organization_settings ORDER BY created_at ASC LIMIT 1') as { organization_id: string } | undefined;
    context = { actorUserId: actor.userId, readableTeamIds, organizationAvailable: Boolean(configured && current.memberships.get(configured.organization_id)?.status === 'active'),
      teams: rows.filter(row => readableTeamIds.has(row.id)).map(row => ({ teamId: row.id, label: label(row.display_name) ?? 'Team' })) };
  } finally { await database.close(); }
  // Scope selection is checked before catalog loading, including nonexistent/unreadable teams.
  projectPluginWorkspaceCatalog([], context, query);
  const { listCapabilityResources } = await import('@/app/lib/capabilities/resources/actions');
  const resources = await listCapabilityResources(actor);
  return projectPluginWorkspaceCatalog(resources, context, query);
}
