import 'server-only';

import { openDb } from '@/app/lib/db';
import { isOrganizationAdminLike, readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { getUserPreferredLocale } from '@/app/lib/user-preferences';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import { memoryCategoryLabel, type MemoryDisplayLocale } from './categories';

export type MemoryApprovalAttentionItem = {
  id: string;
  type: 'memory.approval_required';
  title: string;
  detail: string;
  previewUrl: null;
  occurredAt: string;
  unread: boolean;
  priority: 'normal';
  workspaceId: string;
  workspaceName: string | null;
  target: {
    kind: 'memory';
    scope: 'workspace' | 'organization';
    entryId: string;
    collectionId: string;
    workspaceId?: string;
    organizationId?: string;
  };
};

type ApprovalRow = {
  id: string;
  collection_id: string;
  scope_type: 'workspace' | 'organization';
  workspace_id: string | null;
  organization_id: string | null;
  category: string;
  created_by_name: string | null;
  created_by_email: string | null;
  updated_at: number;
  read_at: number | null;
};

function approvalCopy(locale: MemoryDisplayLocale, category: string, proposer: string | null) {
  const label = memoryCategoryLabel(category, locale);
  if (locale === 'de') {
    return {
      title: 'Memory-Freigabe erforderlich',
      detail: proposer ? `${label} · Eingereicht von ${proposer}` : `${label} · Neuer Vorschlag`,
    };
  }
  return {
    title: 'Memory approval required',
    detail: proposer ? `${label} · Submitted by ${proposer}` : `${label} · New suggestion`,
  };
}

/** Derives approval notifications from current pending rows and current permissions. */
export async function listMemoryApprovalAttention(input: {
  userId: string;
  workspaces: WorkspaceContext[];
}): Promise<MemoryApprovalAttentionItem[]> {
  const managedWorkspaces = input.workspaces.filter((workspace) => workspace.permissions.canManageWorkspace);
  const managedWorkspaceIds = managedWorkspaces.map((workspace) => workspace.workspaceId);
  const workspaceNames = new Map(managedWorkspaces.map((workspace) => [workspace.workspaceId, workspace.displayName || workspace.workspaceType]));
  const [organization, localePreference] = await Promise.all([
    readOrganizationPermissionForUser(input.userId),
    getUserPreferredLocale(input.userId).catch(() => 'en' as const),
  ]);
  const permission = organization.permission;
  const canApproveOrganization = Boolean(
    organization.organizationId
    && permission?.status === 'active'
    && permission.role !== 'external'
    && (isOrganizationAdminLike(permission) || permission.canManageOrganizationMemory === true),
  );
  if (managedWorkspaceIds.length === 0 && !canApproveOrganization) return [];

  const predicates: string[] = [];
  const params: unknown[] = [input.userId];
  if (managedWorkspaceIds.length > 0) {
    predicates.push(`(collection.scope_type = 'workspace' AND collection.workspace_id IN (${managedWorkspaceIds.map(() => '?').join(', ')}))`);
    params.push(...managedWorkspaceIds);
  }
  if (canApproveOrganization && organization.organizationId) {
    predicates.push(`(collection.scope_type = 'organization' AND collection.organization_id = ?)`);
    params.push(organization.organizationId);
  }

  const connection = await openDb();
  try {
    const rows = await connection.all(`
      SELECT entry.id, entry.collection_id, collection.scope_type, collection.workspace_id,
        collection.organization_id, collection.category, entry.updated_at,
        creator.name AS created_by_name, creator.email AS created_by_email,
        read_state.read_at
      FROM memory_entries entry
      INNER JOIN memory_collections collection ON collection.id = entry.collection_id
      LEFT JOIN "user" creator ON creator.id = entry.created_by_user_id
      LEFT JOIN memory_approval_read_states read_state
        ON read_state.entry_id = entry.id AND read_state.user_id = ?
      WHERE entry.status = 'pending' AND collection.status = 'active'
        AND (${predicates.join(' OR ')})
      ORDER BY entry.updated_at DESC, entry.id ASC
    `, params) as ApprovalRow[];
    const locale: MemoryDisplayLocale = localePreference === 'de' ? 'de' : 'en';
    return rows.map((row) => {
      const proposer = row.created_by_name?.trim() || row.created_by_email?.trim() || null;
      const copy = approvalCopy(locale, row.category, proposer);
      const isWorkspace = row.scope_type === 'workspace' && Boolean(row.workspace_id);
      const scopeId = isWorkspace ? row.workspace_id! : row.organization_id!;
      return {
        id: `memory:${row.id}`,
        type: 'memory.approval_required',
        ...copy,
        previewUrl: null,
        occurredAt: new Date(Number(row.updated_at)).toISOString(),
        unread: !row.read_at || Number(row.read_at) < Number(row.updated_at),
        priority: 'normal',
        workspaceId: isWorkspace ? scopeId : `organization:${scopeId}`,
        workspaceName: isWorkspace
          ? workspaceNames.get(scopeId) ?? null
          : locale === 'de' ? 'Organisation' : 'Organization',
        target: isWorkspace
          ? { kind: 'memory', scope: 'workspace', entryId: row.id, collectionId: row.collection_id, workspaceId: scopeId }
          : { kind: 'memory', scope: 'organization', entryId: row.id, collectionId: row.collection_id, organizationId: scopeId },
      };
    });
  } finally {
    await connection.close();
  }
}

async function storeApprovalReadState(userId: string, entryIds: string[], now: number): Promise<number> {
  if (entryIds.length === 0) return 0;
  const connection = await openDb();
  try {
    for (const entryId of entryIds) {
      await connection.run(`
        INSERT INTO memory_approval_read_states (user_id, entry_id, read_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, entry_id) DO UPDATE SET read_at = excluded.read_at, updated_at = excluded.updated_at
      `, [userId, entryId, now, now, now]);
    }
    return entryIds.length;
  } finally {
    await connection.close();
  }
}

export async function markMemoryApprovalAttentionRead(input: {
  userId: string;
  workspaces: WorkspaceContext[];
  itemId: string;
  now?: number;
}): Promise<{ updated: number }> {
  const item = (await listMemoryApprovalAttention(input)).find((candidate) => candidate.id === input.itemId);
  if (!item) throw new Error('Memory approval notification was not found or is no longer accessible.');
  const updated = await storeApprovalReadState(input.userId, [item.target.entryId], input.now ?? Date.now());
  console.info('[MemoryApproval] Notification marked read.', {
    userId: input.userId,
    entryId: item.target.entryId,
    scope: item.target.scope,
  });
  return { updated };
}

export async function markAllMemoryApprovalAttentionRead(input: {
  userId: string;
  workspaces: WorkspaceContext[];
  now?: number;
}): Promise<{ updated: number }> {
  const items = await listMemoryApprovalAttention(input);
  const updated = await storeApprovalReadState(input.userId, items.map((item) => item.target.entryId), input.now ?? Date.now());
  if (updated > 0) console.info('[MemoryApproval] Notifications marked read.', { userId: input.userId, updated });
  return { updated };
}
