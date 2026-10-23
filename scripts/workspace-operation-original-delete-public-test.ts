import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { applyOriginalDeletePublicShareOnConnection as apply, assertOriginalDeletePublicShareOnConnection as preflight,
  captureOriginalDeletePublicShareOnConnection as capture } from '../app/lib/files/workspace-operation-original-delete-public';

// Mechanical borrowed-B unit only: this adapter is not a database, transaction,
// Principal, lease or integration proof. Actual SQL/Owner gates remain separate.
type Row = Record<string, unknown>;
const created = 1700000000000;
function fixture() {
  const workspace: WorkspaceContext = { workspaceId: 'project-space', workspaceType: 'project', organizationId: 'org',
    customerId: 'customer', projectId: 'project', rootPath: '/private/owned/workspace', rootRelativePath: 'projects/project', legacy: false,
    permissions: { canRead: false, canWrite: false, canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false } };
  const original: Row = { id: 'S1', token: 'private-token', tokenHash: createHash('sha256').update('private-token').digest('hex'), tokenPreview: 'preview',
    shortCode: 'ABCDEF', organizationId: 'org', customerId: null, projectId: null, workspaceId: workspace.workspaceId, workspaceType: 'project',
    workspaceRootRelativePath: workspace.rootRelativePath, workspacePath: ' leading.md', documentId: null, lineageId: null, lifecycleGeneration: null,
    fileName: ' leading.md', fileIdentity: 'physical-identity', targetRevisionPolicy: 'latest', lastKnownRevision: 'revision', mimeType: 'text/markdown',
    sizeBytes: 12, status: 'active', createdByUserId: 'creator', createdByAgentId: null, sourceSessionId: null, source: 'ui', securityMode: 'strict',
    reason: null, createdAt: created, updatedAt: created, expiresAt: null, revokedAt: null, revokedReason: null,
    passwordEnabled: 1, passwordHash: 'private-password-hash', lastAccessedAt: null, accessCount: 0, policyRevision: 1 };
  let row = { ...original }; const requests: { sql: string; values: unknown[] }[] = []; let updates = 0;
  const database = { get: (sql: string, values: unknown[] = []) => {
    requests.push({ sql, values: [...values] });
    if (sql.startsWith('UPDATE ')) {
      updates++; assert.equal(values[1], 'S1'); assert.equal(values[8], ' leading.md');
      assert.equal(values[4], row.customerId); assert.equal(values[5], row.projectId); assert.equal(values[18], 'target_deleted');
      assert.equal(row.policyRevision, values[10]); assert.equal(row.status, values[11]);
      row = { ...row, status: 'revoked', policyRevision: Number(row.policyRevision) + 1,
        revokedAt: values[0], revokedReason: values[18], updatedAt: values[0] }; return { ...row };
    }
    assert(sql.startsWith('SELECT ')); assert.equal(values[0], workspace.workspaceId);
    if (sql.includes('workspace_path=$2')) {
      assert.equal(values[1], row.workspacePath); assert(sql.includes('FOR UPDATE NOWAIT')); return row.status === 'active' ? { ...row } : undefined;
    }
    assert(sql.includes('id=$2')); assert.equal(values[1], 'S1'); return { ...row };
  } } as unknown as SqlConnection;
  return { workspace, database, requests, original, read: () => row, updates: () => updates,
    patch: (change: Row) => { row = { ...row, ...change }; } };
}
const expected = (error: unknown) => !!error && typeof error === 'object' && 'code' in error
  && ['ORIGINAL_DELETE_PUBLIC_CHANGED', 'ORIGINAL_DELETE_PUBLIC_INVALID'].includes(String(error.code));

test('legacy optional Project/Customer null pins survive capture/preflight/revoke and terminal replay by original ID', async () => {
  const f = fixture(), original = await capture(f.database, { schema: 'owned', workspace: f.workspace, path: ' leading.md' }); assert(original);
  assert.equal(original.namespace.customerId, null); assert.equal(original.namespace.projectId, null);
  assert(Object.isFrozen(original) && Object.isFrozen(original.namespace));
  const durable = JSON.stringify(original); assert(!durable.includes('private-token')); assert(!durable.includes('private-password-hash'));
  // Dynamic access telemetry between initial capture and final B is permitted.
  f.patch({ accessCount: 4, lastAccessedAt: created + 5, updatedAt: created + 5 });
  const bound = { schema: 'owned', workspace: f.workspace, original, nowMs: created + 10 };
  assert.equal((await preflight(f.database, bound)).kind, 'active'); assert.equal(f.updates(), 0);
  assert.equal((await apply(f.database, bound)).kind, 'revoked'); assert.equal(f.updates(), 1);
  assert.equal(f.read().customerId, null); assert.equal(f.read().projectId, null); assert.equal(f.read().accessCount, 4);
  assert.equal(f.read().lastAccessedAt, created + 5); assert.equal(f.read().passwordHash, f.original.passwordHash);
  assert.equal(f.read().token, f.original.token); assert.equal(f.read().revokedReason, 'target_deleted');
  assert.equal((await preflight(f.database, bound)).kind, 'observed_terminal');
  assert.equal((await apply(f.database, bound)).kind, 'observed_terminal'); assert.equal(f.updates(), 1);
  assert.equal(f.requests.filter(request => request.sql.includes('workspace_path=$2')).length, 1);
  assert(f.requests.filter(request => !request.sql.includes('workspace_path=$2')).every(request => request.values[1] === 'S1'));
});

test('non-null optional namespace conflicts, organization/root/workspace drift and stored pin backfill are rejected without mutation', async () => {
  for (const change of [{ customerId: 'foreign-customer' }, { projectId: 'foreign-project' }, { organizationId: null },
    { workspaceRootRelativePath: 'projects/other' }, { workspaceType: 'team' }]) {
    const f = fixture(); f.patch(change);
    await assert.rejects(() => capture(f.database, { schema: 'owned', workspace: f.workspace, path: ' leading.md' }), expected);
    assert.equal(f.updates(), 0);
  }
  for (const change of [{ customerId: 'customer' }, { projectId: 'project' }, { token: 'substituted-secret' }, { passwordHash: 'substituted-hash' }]) {
    const f = fixture(), original = await capture(f.database, { schema: 'owned', workspace: f.workspace, path: ' leading.md' }); assert(original);
    f.patch(change);
    await assert.rejects(() => preflight(f.database, { schema: 'owned', workspace: f.workspace, original, nowMs: created + 10 }), expected);
    await assert.rejects(() => apply(f.database, { schema: 'owned', workspace: f.workspace, original, nowMs: created + 10 }), expected);
    assert.equal(f.updates(), 0);
  }
});

test('matching non-null Project/Customer pins remain exact and terminal policy drift cannot be adopted', async () => {
  const f = fixture(); f.patch({ customerId: 'customer', projectId: 'project' });
  const original = await capture(f.database, { schema: 'owned', workspace: f.workspace, path: ' leading.md' }); assert(original);
  assert.equal(original.namespace.customerId, 'customer'); assert.equal(original.namespace.projectId, 'project');
  await assert.rejects(() => preflight(f.database, { schema: 'owned', workspace: { ...f.workspace, projectId: 'other' }, original, nowMs: created + 10 }), expected);
  const bound = { schema: 'owned', workspace: f.workspace, original, nowMs: created + 10 };
  await apply(f.database, bound); f.patch({ policyRevision: 3 });
  await assert.rejects(() => apply(f.database, bound), expected); assert.equal(f.updates(), 1);
});
