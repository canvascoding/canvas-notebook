import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { ensureOrganizationBootstrapForUser } from '../app/lib/organization/bootstrap';

function insertUser(sqlite: Database.Database, id: string, name: string, email: string, role: string) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `).run(id, name, email, role, now, now);
}

function insertPermission(sqlite: Database.Database, organizationId: string, userId: string, role: string) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, can_write_team_workspace, can_create_public_links,
      can_delete_team_files, can_delete_studio_assets, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 1, 1, 1, ?, ?)
  `).run(organizationId, userId, role, now, now);
}

function insertProduct(sqlite: Database.Database, id: string, userId: string, organizationId: string, workspaceId: string, name: string) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO studio_products (
      id, user_id, organization_id, workspace_id, created_by_user_id, visibility, name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'workspace', ?, ?, ?)
  `).run(id, userId, organizationId, workspaceId, userId, name, now, now);
}

function insertGeneration(sqlite: Database.Database, id: string, userId: string, organizationId: string, workspaceId: string, prompt: string) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO studio_generations (
      id, user_id, organization_id, workspace_id, created_by_user_id, mode, prompt, raw_prompt,
      aspect_ratio, provider, model, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'image', ?, ?, '1:1', 'gemini', 'gemini-2.5-flash-image', 'completed', ?, ?)
  `).run(id, userId, organizationId, workspaceId, userId, prompt, prompt, now, now);

  sqlite.prepare(`
    INSERT INTO studio_generation_outputs (
      id, generation_id, organization_id, workspace_id, created_by_user_id, variation_index, type,
      file_path, file_name, media_url, mime_type, is_favorite, created_at
    ) VALUES (?, ?, ?, ?, ?, 0, 'image', ?, ?, ?, 'image/png', 0, ?)
  `).run(`out-${id}`, id, organizationId, workspaceId, userId, `${id}.png`, `${id}.png`, `/api/studio/media/studio/outputs/${id}.png`, now);
}

function readCount(sqlite: Database.Database, statement: string, id: string) {
  return (sqlite.prepare(statement).get(id) as { count: number }).count;
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-studio-organization-scope-'));
  const dataRoot = path.join(tempRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  await fs.mkdir(dataRoot, { recursive: true });
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));

  try {
    runMigrations(sqlite);
    insertUser(sqlite, 'user-owner', 'Owner User', 'owner@example.test', 'admin');
    insertUser(sqlite, 'user-member', 'Member User', 'member@example.test', 'member');
    insertUser(sqlite, 'user-outsider', 'Outside User', 'outside@example.test', 'member');

    sqlite.exec('BEGIN IMMEDIATE');
    const ownerStatus = ensureOrganizationBootstrapForUser(sqlite, 'user-owner');
    sqlite.exec('COMMIT');
    assert.equal(ownerStatus.teamFeaturesEnabled, true);
    assert.ok(ownerStatus.organizationId);
    const organizationId = ownerStatus.organizationId;
    const workspaceRows = sqlite.prepare(`
      SELECT id, type FROM canvas_workspaces WHERE organization_id = ? ORDER BY type, created_at
    `).all(organizationId) as Array<{ id: string; type: string }>;
    const sharedWorkspaceId = workspaceRows.find((row) => row.type === 'organization')?.id;
    const personalWorkspaceId = workspaceRows.find((row) => row.type === 'personal')?.id;
    assert.ok(sharedWorkspaceId);
    assert.ok(personalWorkspaceId);

    insertPermission(sqlite, organizationId, 'user-member', 'member');

    insertProduct(sqlite, 'product-owner', 'user-owner', organizationId, sharedWorkspaceId, 'Owner Product');
    insertProduct(sqlite, 'product-member', 'user-member', organizationId, sharedWorkspaceId, 'Member Product');
    insertGeneration(sqlite, 'gen-owner', 'user-owner', organizationId, sharedWorkspaceId, 'Owner generation');
    insertGeneration(sqlite, 'gen-member', 'user-member', organizationId, sharedWorkspaceId, 'Member generation');

    const {
      canReadStudioOutputPath,
      deleteStudioGeneration,
      deleteStudioOutput,
      getStudioGeneration,
      getStudioOutputForUser,
      listStudioGenerations,
    } = await import('../app/lib/integrations/studio-generation-service');
    const { deleteProduct, listProducts } = await import('../app/lib/integrations/studio-product-service');
    const { StudioServiceError } = await import('../app/lib/integrations/studio-errors');
    const { createPersistedStudioScope } = await import('../app/lib/integrations/studio-scope');

    const memberScope = createPersistedStudioScope({
      actorUserId: 'user-member',
      organizationId,
      workspaceId: sharedWorkspaceId,
    });
    const personalScope = createPersistedStudioScope({
      actorUserId: 'user-outsider',
      organizationId,
      workspaceId: personalWorkspaceId,
    });

    const memberProducts = await listProducts(memberScope);
    assert.deepEqual(memberProducts.map((product) => product.id).sort(), ['product-member', 'product-owner']);

    const outsiderProducts = await listProducts(personalScope);
    assert.equal(outsiderProducts.length, 0);

    const memberGenerations = await listStudioGenerations(memberScope);
    assert.deepEqual(memberGenerations.generations.map((generation) => generation.id).sort(), ['gen-member', 'gen-owner']);
    assert.deepEqual(memberGenerations.creators.map((creator) => creator.id).sort(), ['user-member', 'user-owner']);

    const ownerOnlyGenerations = await listStudioGenerations(memberScope, { creatorUserId: 'user-owner' });
    assert.deepEqual(ownerOnlyGenerations.generations.map((generation) => generation.id), ['gen-owner']);

    const visibleOwnerGeneration = await getStudioGeneration('gen-owner', memberScope);
    assert.equal(visibleOwnerGeneration?.createdByUserId, 'user-owner');

    const visibleOwnerOutput = await getStudioOutputForUser('out-gen-owner', memberScope);
    assert.equal(visibleOwnerOutput?.generationId, 'gen-owner');
    assert.equal(await canReadStudioOutputPath('studio/outputs/gen-owner.png', memberScope), true);
    assert.equal(await canReadStudioOutputPath('studio/outputs/gen-owner.png', personalScope), false);

    await assert.rejects(
      () => deleteProduct('product-owner', personalScope),
      (error) => error instanceof StudioServiceError && error.code === 'NOT_FOUND',
    );
    assert.equal(readCount(sqlite, 'SELECT count(*) AS count FROM studio_products WHERE id = ?', 'product-owner'), 1);

    await assert.rejects(
      () => deleteStudioOutput('out-gen-owner', personalScope),
      (error) => error instanceof StudioServiceError && error.code === 'NOT_FOUND',
    );
    assert.equal(readCount(sqlite, 'SELECT count(*) AS count FROM studio_generation_outputs WHERE id = ?', 'out-gen-owner'), 1);

    await assert.rejects(
      () => deleteStudioGeneration('gen-owner', personalScope),
      (error) => error instanceof StudioServiceError && error.code === 'NOT_FOUND',
    );
    assert.equal(readCount(sqlite, 'SELECT count(*) AS count FROM studio_generations WHERE id = ?', 'gen-owner'), 1);
  } finally {
    sqlite.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('studio-organization-scope-test: ok');
}

void main();
