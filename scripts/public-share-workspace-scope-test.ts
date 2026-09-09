import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';

import type { WorkspaceContext } from '../app/lib/workspaces/types';

function workspace(input: {
  id: string;
  rootPath: string;
  rootRelativePath: string;
  displayName: string;
  userId: string;
  canCreatePublicLinks?: boolean;
}): WorkspaceContext {
  return {
    workspaceId: input.id,
    workspaceType: 'team',
    rootPath: input.rootPath,
    rootRelativePath: input.rootRelativePath,
    displayName: input.displayName,
    status: 'active',
    organizationId: 'org-sharing-test',
    ownerUserId: null,
    actor: { userId: input.userId, role: 'admin' },
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: input.canCreatePublicLinks ?? true,
      canManageWorkspace: true,
      canRunAgent: true,
    },
    legacy: false,
  };
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-public-share-workspace-'));
  process.env.DATA = tempRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://workspace-share-test.invalid/canvas';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';

  const postgres = new PGlite();
  const query = async (input: string | { text: string; rowMode?: string }, values?: unknown[]) => {
    const result = await postgres.query<Record<string, unknown>>(typeof input === 'string' ? input : input.text, values);
    return {
      ...result,
      rowCount: result.affectedRows ?? result.rows.length,
      rows: typeof input !== 'string' && input.rowMode === 'array'
        ? result.rows.map((row) => result.fields.map((field) => row[field.name]))
        : result.rows,
    };
  };
  const original = { query: Pool.prototype.query, connect: Pool.prototype.connect };
  Object.defineProperty(Pool.prototype, 'query', { configurable: true, writable: true, value: query });
  Object.defineProperty(Pool.prototype, 'connect', { configurable: true, writable: true, value: async () => ({ query, release() {} }) });

  try {
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const { db } = await import('../app/lib/db');
    const { canvasOrganizationSettings, canvasWorkspaces, user } = await import('../app/lib/db/schema');
    const sharing = await import('../app/lib/public-sharing/public-file-shares');

    const now = new Date();
    await db.insert(user).values({
      id: 'sharing-owner',
      name: 'Sharing Owner',
      email: 'sharing-owner@example.test',
      emailVerified: true,
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(canvasOrganizationSettings).values({
      organizationId: 'org-sharing-test',
      ownerUserId: 'sharing-owner',
      deploymentMode: 'managed-team',
      teamFeaturesEnabled: true,
      createdAt: now,
      updatedAt: now,
    });

    const alphaRoot = path.join(tempRoot, 'teams', 'alpha');
    const betaRoot = path.join(tempRoot, 'teams', 'beta');
    await mkdir(alphaRoot, { recursive: true });
    await mkdir(betaRoot, { recursive: true });
    await writeFile(path.join(alphaRoot, 'notes.md'), '# Alpha\n');
    await writeFile(path.join(betaRoot, 'notes.md'), '# Beta\n');

    await db.insert(canvasWorkspaces).values([
      {
        id: 'workspace-alpha', organizationId: 'org-sharing-test', type: 'team',
        rootRelativePath: 'teams/alpha', displayName: 'Alpha', createdAt: now, updatedAt: now,
      },
      {
        id: 'workspace-beta', organizationId: 'org-sharing-test', type: 'team',
        rootRelativePath: 'teams/beta', displayName: 'Beta', createdAt: now, updatedAt: now,
      },
    ]);

    const alpha = workspace({
      id: 'workspace-alpha', rootPath: alphaRoot, rootRelativePath: 'teams/alpha',
      displayName: 'Alpha', userId: 'sharing-owner',
    });
    const beta = workspace({
      id: 'workspace-beta', rootPath: betaRoot, rootRelativePath: 'teams/beta',
      displayName: 'Beta', userId: 'sharing-owner',
    });

    const alphaResult = await sharing.createPublicFileShares({
      paths: ['notes.md'], createdByUserId: 'sharing-owner', workspace: alpha,
    });
    const betaResult = await sharing.createPublicFileShares({
      paths: ['notes.md'], createdByUserId: 'sharing-owner', workspace: beta,
    });
    assert.equal(alphaResult.shares.length, 1, JSON.stringify(alphaResult.skipped));
    assert.equal(betaResult.shares.length, 1, JSON.stringify(betaResult.skipped));
    const alphaShare = alphaResult.shares[0];
    const betaShare = betaResult.shares[0];
    assert.notEqual(alphaShare.id, betaShare.id, 'Identical relative paths stay isolated by workspace');
    assert.notEqual(alphaShare.publicPath, betaShare.publicPath);

    const alphaList = await sharing.listPublicFileShares({ userId: 'sharing-owner', workspace: alpha });
    const betaList = await sharing.listPublicFileShares({ userId: 'sharing-owner', workspace: beta });
    assert.deepEqual(alphaList.map((share) => share.id), [alphaShare.id]);
    assert.deepEqual(betaList.map((share) => share.id), [betaShare.id]);
    assert.equal(await sharing.updatePublicFileShare({
      id: betaShare.id,
      userId: 'sharing-owner',
      workspace: alpha,
      expectedPolicyRevision: betaShare.policyRevision,
      reason: 'cross-workspace update',
    }), null);
    assert.equal(await sharing.revokePublicFileShare({ id: betaShare.id, userId: 'sharing-owner', workspace: alpha }), null);

    const betaToken = decodeURIComponent(betaShare.publicPath.split('/')[3]);
    const betaResolution = await sharing.resolvePublicShareToken(betaToken, { recordAccess: false });
    assert.ok(betaResolution.ok);
    assert.equal(betaResolution.workspace.workspaceId, beta.workspaceId);
    assert.equal(betaResolution.fullPath, await realpath(path.join(betaRoot, 'notes.md')));

    const fileRoute = await import('../app/public/files/[token]/[...filename]/route');
    const betaResponse = await fileRoute.GET(new NextRequest('http://localhost/public/files'), {
      params: Promise.resolve({ token: betaToken, filename: ['notes.md'] }),
    });
    assert.equal(betaResponse.status, 200);
    assert.equal(await betaResponse.text(), '# Beta\n');
    const wrongName = await fileRoute.GET(new NextRequest('http://localhost/public/files'), {
      params: Promise.resolve({ token: betaToken, filename: ['alpha.md'] }),
    });
    assert.equal(wrongName.status, 404);

    await unlink(path.join(alphaRoot, 'notes.md'));
    await sharing.syncPublicSharesAfterDelete(['notes.md'], alpha);
    const alphaToken = decodeURIComponent(alphaShare.publicPath.split('/')[3]);
    assert.equal((await sharing.resolvePublicShareToken(alphaToken, { recordAccess: false })).ok, false);
    assert.equal((await sharing.resolvePublicShareToken(betaToken, { recordAccess: false })).ok, true);

    await assert.rejects(sharing.createPublicFileShares({
      paths: ['notes.md'],
      createdByUserId: 'sharing-owner',
      workspace: workspace({
        id: 'workspace-beta', rootPath: betaRoot, rootRelativePath: 'teams/beta',
        displayName: 'Beta', userId: 'sharing-owner', canCreatePublicLinks: false,
      }),
    }), /permission/i);

    console.log('public-share-workspace-scope-test: PostgreSQL workspace isolation, routes, permissions and lifecycle ok');
  } finally {
    Object.assign(Pool.prototype, original);
    await postgres.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
