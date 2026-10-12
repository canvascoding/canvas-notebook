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
  const { metadata, access } = entry;
  if (!access.canRead || metadata.ownership.type === 'system') return {};
  const ownership = metadata.ownership;
  const references = {
    owner: ownership.type === 'user' ? ownership.ownerUserId : null,
    createdBy: metadata.createdByUserId,
    updatedBy: metadata.updatedByUserId,
    responsible: metadata.responsibleUserId,
  };
  const ids = [...new Set(Object.values(references).filter((id): id is string => Boolean(id)))];
  if (!ids.length && ownership.type !== 'team') return {};
  const database = await openDb();
  try {
    const names = new Map<string, string | null>();
    if (ids.length) {
      const placeholders = ids.map((_, index) => `$${index + 2}`).join(', ');
      // Former authors can remain named as provenance. No email, role or unrelated user is exposed.
      const rows = ownership.organizationId
        ? await database.all(`SELECT u.id, u.name FROM "user" u
            JOIN organization_user_permissions p ON p.user_id = u.id
            WHERE p.organization_id = $1 AND u.id IN (${placeholders})`, [ownership.organizationId, ...ids])
        : await database.all(`SELECT id, name FROM "user" WHERE id = $1 AND id IN (${placeholders})`, [actor.userId, ...ids]);
      for (const row of rows as Array<{ id: string; name: string }>) names.set(row.id, safeLabel(row.name));
    }
    const people: NonNullable<CapabilityResourceDescriptor['people']> = {};
    for (const [role, userId] of Object.entries(references)) {
      if (userId) people[role as keyof typeof people] = { userId, name: names.get(userId) ?? null };
    }
    let ownershipLabel: string | null = ownership.type === 'user' ? names.get(ownership.ownerUserId) ?? null : null;
    if (ownership.type === 'team') {
      const team = await database.get(`SELECT display_name FROM canvas_workspaces
        WHERE id = $1 AND organization_id = $2 AND type = 'team' AND status = 'active'`, [ownership.workspaceId, ownership.organizationId]) as { display_name: unknown } | undefined;
      ownershipLabel = safeLabel(team?.display_name);
    }
    return { ...(Object.keys(people).length ? { people } : {}), ...(ownershipLabel ? { ownershipLabel } : {}) };
  } finally {
    await database.close();
  }
}
