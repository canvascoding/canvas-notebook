import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type { OrganizationPermissionSnapshot } from '../app/lib/organization/contracts';
import type { WorkspaceContext, WorkspacePermissions } from '../app/lib/workspaces/types';

const READ_ONLY: WorkspacePermissions = {
  canRead: true,
  canWrite: false,
  canDelete: false,
  canCreatePublicLinks: false,
  canManageWorkspace: false,
  canRunAgent: true,
};

const NO_ACCESS: WorkspacePermissions = {
  canRead: false,
  canWrite: false,
  canDelete: false,
  canCreatePublicLinks: false,
  canManageWorkspace: false,
  canRunAgent: false,
};

function workspace(input: {
  id: string;
  type: 'personal' | 'organization' | 'team' | 'project';
  organizationId: string;
  actorUserId: string;
  ownerUserId?: string | null;
  permissions?: WorkspacePermissions;
}): WorkspaceContext {
  return {
    workspaceId: input.id,
    workspaceType: input.type,
    rootPath: `/tmp/${input.id}`,
    rootRelativePath: `workspaces/${input.id}`,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId ?? null,
    actor: { userId: input.actorUserId, role: 'member' },
    permissions: input.permissions ?? READ_ONLY,
    legacy: false,
  };
}

function organizationPermission(
  role: OrganizationPermissionSnapshot['role'],
  overrides: Partial<OrganizationPermissionSnapshot> = {},
): OrganizationPermissionSnapshot {
  return {
    role,
    status: 'active',
    canWriteTeamWorkspace: role === 'owner' || role === 'admin',
    canCreatePublicLinks: true,
    canCreateTeamAutomations: role === 'owner' || role === 'admin',
    canSharePluginsAndSkills: role === 'owner' || role === 'admin',
    canExport: role === 'owner' || role === 'admin',
    canDeleteTeamFiles: role === 'owner' || role === 'admin',
    canDeleteStudioAssets: true,
    canManageBackups: role === 'owner' || role === 'admin',
    canMigrateDatabase: role === 'owner' || role === 'admin',
    canEnableKnowledge: role === 'owner' || role === 'admin',
    canManageOrganizationMemory: role === 'owner' || role === 'admin',
    canRecoverWorkspaces: role === 'owner' || role === 'admin',
    ...overrides,
  };
}

async function main() {
  const postgres = new PGlite();
  try {
    const db = drizzle(postgres);
    const knowledgeChunks = pgTable('knowledge_chunks', {
      id: text('id').primaryKey(),
      organizationId: text('organization_id'),
      workspaceId: text('workspace_id'),
      userId: text('user_id'),
      knowledgeStore: text('knowledge_store').notNull(),
      scanStatus: text('scan_status').notNull(),
      policyDecision: text('policy_decision').notNull(),
      embeddingIndexStatus: text('embedding_index_status').notNull(),
      revokedAt: timestamp('revoked_at'),
    });
    await postgres.exec(`
      CREATE TABLE knowledge_chunks (
        id text PRIMARY KEY,
        organization_id text,
        workspace_id text,
        user_id text,
        knowledge_store text NOT NULL,
        scan_status text NOT NULL,
        policy_decision text NOT NULL,
        embedding_index_status text NOT NULL,
        revoked_at timestamptz
      )
    `);
    const {
      knowledgeRetrievalCondition,
      knowledgeSourceScopeForWorkspace,
      resolveKnowledgeRetrievalScope,
    } = await import('../app/lib/knowledge/retrieval-scope');

    const personalWorkspace = workspace({
      id: 'ws-personal-a',
      type: 'personal',
      organizationId: 'org-a',
      actorUserId: 'user-a',
      ownerUserId: 'user-a',
    });
    const teamWorkspace = workspace({
      id: 'ws-team-a',
      type: 'team',
      organizationId: 'org-a',
      actorUserId: 'user-a',
    });
    const hiddenTeamWorkspace = workspace({
      id: 'ws-team-hidden',
      type: 'project',
      organizationId: 'org-a',
      actorUserId: 'user-a',
      permissions: NO_ACCESS,
    });

    assert.deepEqual(knowledgeSourceScopeForWorkspace(personalWorkspace), {
      organizationId: 'org-a',
      workspaceId: 'ws-personal-a',
      userId: 'user-a',
      knowledgeStore: 'personal_user',
      visibility: 'private',
    });
    assert.deepEqual(knowledgeSourceScopeForWorkspace(teamWorkspace), {
      organizationId: 'org-a',
      workspaceId: 'ws-team-a',
      userId: null,
      knowledgeStore: 'team_workspace',
      visibility: 'team',
    });
    assert.throws(() => knowledgeSourceScopeForWorkspace(hiddenTeamWorkspace), /not readable/);

    const sources = [
      ['src-personal-a', 'personal_user', 'private', 'ws-personal-a', 'user-a', 'allow', 'clean', null],
      ['src-personal-b', 'personal_user', 'private', 'ws-personal-b', 'user-b', 'allow', 'clean', null],
      ['src-team-a', 'team_workspace', 'team', 'ws-team-a', null, 'allow', 'clean', null],
      ['src-team-hidden', 'team_workspace', 'team', 'ws-team-hidden', null, 'allow', 'clean', null],
      ['src-org-a', 'organization', 'organization', null, null, 'allow', 'clean', null],
      ['src-flagged', 'team_workspace', 'team', 'ws-team-a', null, 'allow', 'flagged', null],
      ['src-blocked', 'team_workspace', 'team', 'ws-team-a', null, 'block', 'blocked', null],
      ['src-revoked', 'team_workspace', 'team', 'ws-team-a', null, 'allow', 'clean', Date.now()],
    ] as const;

    for (const [id, knowledgeStore, _visibility, workspaceId, userId, policyDecision, scanStatus, revokedAt] of sources) {
      await db.insert(knowledgeChunks).values({
        id: `chunk-${id}`,
        organizationId: 'org-a',
        workspaceId,
        userId,
        knowledgeStore,
        scanStatus,
        policyDecision,
        embeddingIndexStatus: 'disabled',
        revokedAt: revokedAt ? new Date(revokedAt) : null,
      });
    }

    const baseScope = resolveKnowledgeRetrievalScope({
      actorUserId: 'user-a',
      workspaces: [personalWorkspace, teamWorkspace, hiddenTeamWorkspace],
      organizationPermission: organizationPermission('member'),
      includeOrganizationKnowledge: true,
    });

    const baseRows = await db.select({ id: knowledgeChunks.id })
      .from(knowledgeChunks)
      .where(knowledgeRetrievalCondition(baseScope, {
        organizationId: knowledgeChunks.organizationId,
        workspaceId: knowledgeChunks.workspaceId,
        userId: knowledgeChunks.userId,
        knowledgeStore: knowledgeChunks.knowledgeStore,
        scanStatus: knowledgeChunks.scanStatus,
        policyDecision: knowledgeChunks.policyDecision,
        embeddingIndexStatus: knowledgeChunks.embeddingIndexStatus,
        revokedAt: knowledgeChunks.revokedAt,
      }))
      .orderBy(knowledgeChunks.id);

    assert.deepEqual(baseRows.map((row) => row.id), ['chunk-src-personal-a', 'chunk-src-team-a']);

    const adminScope = resolveKnowledgeRetrievalScope({
      actorUserId: 'user-a',
      workspaces: [personalWorkspace, teamWorkspace],
      organizationPermission: organizationPermission('admin'),
      includeOrganizationKnowledge: true,
    });
    const adminRows = await db.select({ id: knowledgeChunks.id })
      .from(knowledgeChunks)
      .where(knowledgeRetrievalCondition(adminScope, {
        organizationId: knowledgeChunks.organizationId,
        workspaceId: knowledgeChunks.workspaceId,
        userId: knowledgeChunks.userId,
        knowledgeStore: knowledgeChunks.knowledgeStore,
        scanStatus: knowledgeChunks.scanStatus,
        policyDecision: knowledgeChunks.policyDecision,
        embeddingIndexStatus: knowledgeChunks.embeddingIndexStatus,
        revokedAt: knowledgeChunks.revokedAt,
      }))
      .orderBy(knowledgeChunks.id);

    assert.deepEqual(adminRows.map((row) => row.id), ['chunk-src-org-a', 'chunk-src-personal-a', 'chunk-src-team-a']);

    const personalOnlyAdminScope = resolveKnowledgeRetrievalScope({
      actorUserId: 'user-a',
      workspaces: [personalWorkspace],
      organizationPermission: organizationPermission('owner'),
      includeOrganizationKnowledge: true,
    });
    const personalOnlyAdminRows = await db.select({ id: knowledgeChunks.id })
      .from(knowledgeChunks)
      .where(knowledgeRetrievalCondition(personalOnlyAdminScope, {
        organizationId: knowledgeChunks.organizationId,
        workspaceId: knowledgeChunks.workspaceId,
        userId: knowledgeChunks.userId,
        knowledgeStore: knowledgeChunks.knowledgeStore,
        scanStatus: knowledgeChunks.scanStatus,
        policyDecision: knowledgeChunks.policyDecision,
        embeddingIndexStatus: knowledgeChunks.embeddingIndexStatus,
        revokedAt: knowledgeChunks.revokedAt,
      }))
      .orderBy(knowledgeChunks.id);

    assert.deepEqual(personalOnlyAdminRows.map((row) => row.id), ['chunk-src-org-a', 'chunk-src-personal-a']);

    const adminWithoutKnowledgeScope = resolveKnowledgeRetrievalScope({
      actorUserId: 'user-a',
      workspaces: [personalWorkspace, teamWorkspace],
      organizationPermission: organizationPermission('admin', { canEnableKnowledge: false }),
      includeOrganizationKnowledge: true,
    });
    const adminWithoutKnowledgeRows = await db.select({ id: knowledgeChunks.id })
      .from(knowledgeChunks)
      .where(knowledgeRetrievalCondition(adminWithoutKnowledgeScope, {
        organizationId: knowledgeChunks.organizationId,
        workspaceId: knowledgeChunks.workspaceId,
        userId: knowledgeChunks.userId,
        knowledgeStore: knowledgeChunks.knowledgeStore,
        scanStatus: knowledgeChunks.scanStatus,
        policyDecision: knowledgeChunks.policyDecision,
        embeddingIndexStatus: knowledgeChunks.embeddingIndexStatus,
        revokedAt: knowledgeChunks.revokedAt,
      }))
      .orderBy(knowledgeChunks.id);

    assert.deepEqual(adminWithoutKnowledgeRows.map((row) => row.id), ['chunk-src-personal-a', 'chunk-src-team-a']);
  } finally { await postgres.close(); }

  console.log('knowledge-retrieval-scope-test: ok');
}

void main();
