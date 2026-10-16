import 'server-only';

import { openDb } from '@/app/lib/db';
import type { CapabilityResourceAccessEntry, CapabilityResourceActor, CapabilityResourceDescriptor } from './contracts';

function safeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, 200) || null;
}

/** A readable descriptor may name its existing authors without granting directory access. */
export async function readCapabilityResourceLabels(actor: CapabilityResourceActor, entry: CapabilityResourceAccessEntry): Promise<
  Pick<CapabilityResourceDescriptor, 'people' | 'ownershipLabel'>
> {
  return (await readCapabilityResourceLabelsBatch(actor, [entry]))[0];
}

/** Names remain scoped to each readable resource's existing references; no directory result is exposed. */
export async function readCapabilityResourceLabelsBatch(actor: CapabilityResourceActor,
  entries: readonly CapabilityResourceAccessEntry[]): Promise<Array<Pick<CapabilityResourceDescriptor, 'people' | 'ownershipLabel'>>> {
  const selected = entries.map(entry => {
    const ownership = entry.metadata.ownership;
    if (!entry.access.canRead || ownership.type === 'system') return null;
    const references = { owner: ownership.type === 'user' ? ownership.ownerUserId : null,
      createdBy: entry.metadata.createdByUserId, updatedBy: entry.metadata.updatedByUserId, responsible: entry.metadata.responsibleUserId };
    return { ownership, references };
  });
  const ids = [...new Set(selected.flatMap(entry => entry ? Object.values(entry.references).filter((id): id is string => Boolean(id)) : []))];
  const teamIds = [...new Set(selected.flatMap(entry => entry?.ownership.type === 'team' ? [entry.ownership.workspaceId] : []))];
  if (!ids.length && !teamIds.length) return entries.map(() => ({}));
  const database = await openDb();
  try {
    const names = new Map<string, string | null>();
    const key = (organizationId: string | null, id: string) => JSON.stringify([organizationId, id]);
    if (ids.length) {
      const organizations = [...new Set(selected.flatMap(entry => entry?.ownership.organizationId ? [entry.ownership.organizationId] : []))];
      if (organizations.length) {
        // Historical membership is sufficient for already named provenance, just as in the individual read.
        const rows = await database.all(`SELECT u.id,u.name,p.organization_id FROM "user" u
          JOIN organization_user_permissions p ON p.user_id=u.id
          WHERE p.organization_id=ANY($1::text[]) AND u.id=ANY($2::text[])`, [organizations, ids]);
        for (const row of rows as Array<{ id: string; name: string; organization_id: string }>) {
          names.set(key(row.organization_id, row.id), safeLabel(row.name));
        }
      }
      if (selected.some(entry => entry?.ownership.organizationId === null) && ids.includes(actor.userId)) {
        const row = await database.get('SELECT id,name FROM "user" WHERE id=$1', [actor.userId]) as { id: string; name: string } | undefined;
        if (row) names.set(key(null, row.id), safeLabel(row.name));
      }
    }
    const teams = new Map<string, string | null>();
    if (teamIds.length) {
      const rows = await database.all(`SELECT id,organization_id,display_name FROM canvas_workspaces
        WHERE id=ANY($1::text[]) AND type='team' AND status='active'`, [teamIds]);
      for (const row of rows as Array<{ id: string; organization_id: string; display_name: unknown }>) {
        teams.set(key(row.organization_id, row.id), safeLabel(row.display_name));
      }
    }
    return selected.map(entry => {
      if (!entry) return {};
      const { ownership, references } = entry;
      const people: NonNullable<CapabilityResourceDescriptor['people']> = {};
      for (const [role, userId] of Object.entries(references)) {
        if (userId) people[role as keyof typeof people] = { userId, name: names.get(key(ownership.organizationId, userId)) ?? null };
      }
      const ownershipLabel = ownership.type === 'user' ? names.get(key(ownership.organizationId, ownership.ownerUserId))
        : ownership.type === 'team' ? teams.get(key(ownership.organizationId, ownership.workspaceId)) : null;
      return { ...(Object.keys(people).length ? { people } : {}), ...(ownershipLabel ? { ownershipLabel } : {}) };
    });
  } finally {
    await database.close();
  }
}
