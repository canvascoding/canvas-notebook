import 'server-only';

import { openDb } from '@/app/lib/db';
import { authority } from '@/app/lib/capabilities/scope-authority';
import { CapabilityResourceError, type CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import { PLUGIN_WORKSPACE_CATALOG_MAX_TEAM_CHOICES, type PluginWorkspaceCatalogItem,
  type PluginWorkspaceCatalogQuery, type PluginWorkspaceCatalogScopeContext } from './plugin-workspace-catalog-contracts';

type SelectionItem = Pick<PluginWorkspaceCatalogItem, 'resourceRef' | 'kind' | 'name' | 'displayName' | 'description' | 'ownership' | 'ownershipLabel'>;

/** One unpaginated ownership/search selection for installed metadata and Store comparisons. */
export function selectPluginWorkspaceItems<T extends SelectionItem>(items: readonly T[], context: PluginWorkspaceCatalogScopeContext,
  selection: Pick<PluginWorkspaceCatalogQuery, 'scope' | 'audience' | 'teamId' | 'kind' | 'q'>): T[] {
  if (selection.scope === 'team' && selection.teamId && !context.readableTeamIds.has(selection.teamId)) {
    throw new CapabilityResourceError('PLUGIN_CATALOG_TEAM_NOT_FOUND', 'The selected team is unavailable in this context.', 404);
  }
  if (selection.scope === 'team' && !selection.teamId) return [];
  const search = selection.q.toLocaleLowerCase('en-US');
  return items.filter(item => {
    if (selection.kind && item.kind !== selection.kind) return false;
    const owner = item.ownership;
    if (selection.scope === 'user') {
      const own = owner.type === 'user' && owner.ownerUserId === context.actorUserId;
      if (selection.audience === 'own' ? !own : own || owner.type === 'system') return false;
    } else if (selection.scope === 'team' && (owner.type !== 'team' || owner.workspaceId !== selection.teamId)) return false;
    else if (selection.scope === 'organization' && owner.type !== 'organization') return false;
    else if (selection.scope === 'system' && owner.type !== 'system') return false;
    return !search || [item.name, item.displayName, item.description, item.ownershipLabel ?? '']
      .some(value => value.toLocaleLowerCase('en-US').includes(search));
  }).sort((left, right) => {
    const leftName = left.displayName.toLocaleLowerCase('en-US'), rightName = right.displayName.toLocaleLowerCase('en-US');
    return leftName < rightName ? -1 : leftName > rightName ? 1 : left.resourceRef < right.resourceRef ? -1 : left.resourceRef > right.resourceRef ? 1 : 0;
  });
}

/** Fresh read choices are independent of installation/management authority. */
export async function resolvePluginWorkspaceCatalogScopeContext(input: CapabilityResourceActor): Promise<PluginWorkspaceCatalogScopeContext> {
  const actor: CapabilityResourceActor = { userId: input.userId, workspaceId: input.workspaceId?.trim() || null };
  if (!actor.userId || actor.userId.length > 200 || /[\u0000-\u001f\u007f]/u.test(actor.userId)
    || actor.workspaceId && (actor.workspaceId.length > 200 || /[\u0000-\u001f\u007f]/u.test(actor.workspaceId))) {
    throw new CapabilityResourceError('PLUGIN_CATALOG_QUERY_INVALID', 'The catalog query does not match the supported fields.', 400);
  }
  const database = await openDb();
  try {
    const current = await authority(database, actor);
    if (!current.valid || !current.contextValid) throw new CapabilityResourceError('PLUGIN_CATALOG_ACCESS_DENIED', 'This catalog context is unavailable.', 403);
    const readableTeamIds = new Set([...current.workspaces.values()]
      .filter(workspace => workspace.type === 'team' && workspace.status === 'active' && workspace.canRead).map(workspace => workspace.id));
    const ids = [...readableTeamIds].sort().slice(0, PLUGIN_WORKSPACE_CATALOG_MAX_TEAM_CHOICES);
    const rows = ids.length ? (await database.all(`SELECT id, display_name FROM canvas_workspaces WHERE id IN (${ids.map((_, index) => `$${index + 1}`).join(',')}) AND type='team' AND status='active' ORDER BY lower(display_name), id LIMIT ${PLUGIN_WORKSPACE_CATALOG_MAX_TEAM_CHOICES}`, ids) as Array<{ id: string; display_name: unknown }>) : [];
    const configured = await database.get('SELECT organization_id FROM canvas_organization_settings ORDER BY created_at ASC LIMIT 1') as { organization_id: string } | undefined;
    return { actorUserId: actor.userId, readableTeamIds,
      organizationAvailable: Boolean(configured && current.memberships.get(configured.organization_id)?.status === 'active'),
      teams: rows.filter(row => readableTeamIds.has(row.id)).map(row => ({ teamId: row.id,
        label: typeof row.display_name === 'string' ? row.display_name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, 200) || 'Team' : 'Team' })) };
  } finally { await database.close(); }
}
