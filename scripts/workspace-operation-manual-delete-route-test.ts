import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { NextRequest } from 'next/server';
import type * as Route from '../app/api/files/delete/route';

async function main(): Promise<void> {
  const file = path.resolve('app/api/files/delete/route.ts');
  const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const workspace = { workspaceId: 'workspace', rootPath: '/isolated/workspace', organizationId: null, workspaceType: 'personal' };
  const session = { user: { id: 'user', name: 'User' } };
  let blocked = false;
  let needsReview = true;
  let revoked = false;
  let accessChecks = 0;
  let writes = 0;
  let audits = 0;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const route = { exports: {} as typeof Route };
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name.endsWith('/route-helpers')) return {
      applyRateLimit: () => null, invalidateWorkspaceFileViews: () => undefined,
      readJsonBody: (request: Request) => request.json(),
      jsonSuccess: (payload: unknown) => json({ success: true, ...(payload as object) }),
      jsonError: (error: string, status: number, details: object = {}) => json({ success: false, error, ...details }, status),
      jsonServerError: () => json({ success: false }, 500),
    };
    if (name.endsWith('/workspaces/request')) return {
      workspaceFileOptions: () => ({ workspace }),
      requireRequestWorkspace: async () => {
        accessChecks += 1;
        return revoked && accessChecks > 1 ? { response: json({}, 403) } : { workspace, session, response: null };
      },
    };
    if (name.endsWith('/workspace-operation-delete-review')) return {
      reviewWorkspaceDeletionIfRequired: async () => needsReview ? { blocked, reviewRequired: {
        reviewId: 'review-1234567890', planId: 'a'.repeat(64), workspaceId: 'workspace', status: blocked ? 'blocked' : 'pending',
      } } : null,
    };
    if (name.endsWith('/workspace-mutation-lock')) return { withWorkspaceMutationLock: (_id: string, action: () => unknown) => action() };
    if (name.endsWith('/workspace-trash')) return { trashWorkspacePaths: async () => {
      writes += 1;
      return { trashed: [{ id: 'trash-id', originalPath: 'target.md', itemType: 'file', sizeBytes: 10, expiresAt: new Date(0) }], failed: [] };
    } };
    if (name.endsWith('/audit-service')) return { recordAuditEvent: async () => { audits += 1; } };
    if (name.endsWith('/app-output-folders')) return { isProtectedAppOutputFolder: () => false };
    if (name.endsWith('/public-file-shares')) return { syncPublicSharesAfterDelete: async () => undefined };
    if (name.endsWith('/collaboration-policy')) return { archiveFileCollaborationPaths: async () => undefined };
    if (name.endsWith('/path-utils')) return { getParentDirectory: () => '.' };
    throw new Error(`Unexpected route dependency: ${name}`);
  }, route, route.exports);
  const remove = () => {
    accessChecks = 0;
    return route.exports.DELETE(new Request('http://localhost/api/files/delete', {
      method: 'DELETE', body: JSON.stringify({ path: 'target.md' }),
    }) as unknown as NextRequest);
  };
  const ready = await remove();
  assert.equal(ready.status, 200);
  const readyBody = await ready.json();
  assert.deepEqual(readyBody.deleted, []);
  assert.deepEqual(readyBody.trashEntries, []);
  assert.equal(readyBody.reviewRequired.status, 'pending');
  assert.equal(writes, 0);
  blocked = true;
  const unsafe = await remove();
  assert.equal(unsafe.status, 409);
  const unsafeBody = await unsafe.json();
  assert.equal(unsafeBody.success, false);
  assert.equal(unsafeBody.code, 'PREVIEW_BLOCKED');
  assert.equal(unsafeBody.reviewRequired.status, 'blocked');
  assert.equal(writes, 0);
  needsReview = false;
  const direct = await remove();
  assert.equal(direct.status, 200);
  const directBody = await direct.json();
  assert.deepEqual(directBody.deleted, ['target.md']);
  assert.equal(directBody.trashEntries[0].id, 'trash-id');
  assert.deepEqual(directBody.failed, []);
  assert.equal(writes, 1);
  assert.equal(audits, 1);
  revoked = true;
  assert.equal((await remove()).status, 403);
  assert.equal(writes, 1, 'revoked access inside the lock prevents direct trash');
  console.log('manual DELETE route: pending cleanup reference, blocked409 without mutation, legacy trash shape, refreshed permission fence OK');
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
