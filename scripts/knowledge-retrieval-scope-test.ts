import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { OrganizationPermissionSnapshot } from '../app/lib/organization/bootstrap';
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
  type: 'personal' | 'team' | 'project';
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
    canRecoverWorkspaces: role === 'owner' || role === 'admin',
    ...overrides,
  };
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-knowledge-retrieval-scope-'));
  process.env.DATA = path.join(tempRoot, 'data');

  try {
    const { db } = await import('../app/lib/db');
    const { knowledgeChunks, knowledgeSources, user, canvasOrganizationSettings, canvasProjects, canvasWorkspaces } = await import('../app/lib/db/schema');
    const {
      knowledgeRetrievalCondition,
      knowledgeSourceScopeForWorkspace,
      resolveKnowledgeRetrievalScope,
    } = await import('../app/lib/knowledge/retrieval-scope');

    const now = new Date();
    await db.insert(user).values([
      { id: 'user-a', name: 'User A', email: 'a@example.test', emailVerified: true, role: 'admin', createdAt: now, updatedAt: now },
      { id: 'user-b', name: 'User B', email: 'b@example.test', emailVerified: true, role: 'member', createdAt: now, updatedAt: now },
    ]);
    await db.insert(canvasOrganizationSettings).values({
      organizationId: 'org-a',
      ownerUserId: 'user-a',
      deploymentMode: 'managed_team',
      teamFeaturesEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(canvasProjects).values({
      id: 'project-hidden',
      organizationId: 'org-a',
      name: 'Hidden Project',
      slug: 'hidden-project',
      status: 'active',
      createdByUserId: 'user-a',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(canvasWorkspaces).values([
      { id: 'ws-personal-a', organizationId: 'org-a', type: 'personal', ownerUserId: 'user-a', rootRelativePath: 'workspaces/personal/user-a/files', displayName: 'A', status: 'active', createdAt: now, updatedAt: now },
      { id: 'ws-personal-b', organizationId: 'org-a', type: 'personal', ownerUserId: 'user-b', rootRelativePath: 'workspaces/personal/user-b/files', displayName: 'B', status: 'active', createdAt: now, updatedAt: now },
      { id: 'ws-team-a', organizationId: 'org-a', type: 'team', ownerUserId: null, rootRelativePath: 'workspaces/team/org-a/files', displayName: 'Team', status: 'active', createdAt: now, updatedAt: now },
      { id: 'ws-team-hidden', organizationId: 'org-a', type: 'project', ownerUserId: null, projectId: 'project-hidden', rootRelativePath: 'workspaces/project/hidden/files', displayName: 'Hidden', status: 'active', createdAt: now, updatedAt: now },
    ]);

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

    for (const [id, knowledgeStore, visibility, workspaceId, userId, policyDecision, scanStatus, revokedAt] of sources) {
      await db.insert(knowledgeSources).values({
        id,
        organizationId: 'org-a',
        workspaceId,
        userId,
        createdByUserId: 'user-a',
        knowledgeStore,
        visibility,
        sourceType: 'file',
        sourcePath: `${id}.md`,
        parserProvider: 'native',
        scanStatus,
        policyDecision,
        embeddingIndexStatus: 'disabled',
        databaseProvider: 'sqlite',
        status: 'indexed',
        revokedAt: revokedAt ? new Date(revokedAt) : null,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(knowledgeChunks).values({
        id: `chunk-${id}`,
        sourceId: id,
        organizationId: 'org-a',
        workspaceId,
        userId,
        knowledgeStore,
        visibility,
        chunkIndex: 0,
        text: id,
        scanStatus,
        policyDecision,
        embeddingIndexStatus: 'disabled',
        revokedAt: revokedAt ? new Date(revokedAt) : null,
        createdAt: now,
        updatedAt: now,
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
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('knowledge-retrieval-scope-test: ok');
}

void main();
