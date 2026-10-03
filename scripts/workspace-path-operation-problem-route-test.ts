import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { NextRequest } from 'next/server';
import type * as Route from '../app/api/files/operations/problems/[problemId]/route';

async function main(): Promise<void> {
  const source = ts.transpileModule(await fs.readFile(path.resolve('app/api/files/operations/problems/[problemId]/route.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let authenticated = true;
  let authorized = true;
  let canRead = true;
  let active = true;
  let foreignScope = false;
  let limited = false;
  let storageUnavailable = false;
  let reads = 0;
  let authorityReads = 0;
  const problemId = 'problem_route_1234567890';
  const problem = { problemId, workspaceId: 'problem-workspace', kind: 'move',
    selections: [{ sourcePath: 'old.md', destinationPath: 'new.md' }], errorCode: 'BATCH_OVERWRITE_REQUIRES_FILES',
    createdAt: 1, updatedAt: 2,
    actorUserId: 'private-actor', metadataJson: 'private-metadata', absolutePath: '/private/storage', rawError: 'Private error' };
  const jsonError = (error: string, status: number) => Response.json({ success: false, error }, { status });
  const compiled = { exports: {} as typeof Route };
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'next/server') return { NextRequest };
    if (name.endsWith('/auth')) return { auth: { api: { getSession: async () => authenticated ? { user: { id: 'viewer' } } : null } } };
    if (name.endsWith('/route-helpers')) return {
      applyRateLimit: () => limited ? jsonError('Limited', 429) : null, jsonError,
      jsonSuccess: (body: object) => Response.json({ success: true, ...body }),
      jsonServerError: () => jsonError('Could not read file action problem', 500),
    };
    if (name.endsWith('/workspace-path-operation-problems')) return {
      createWorkspacePathOperationProblemStore: () => ({ get: async (id: string) => {
        reads += 1;
        if (storageUnavailable) throw new Error('Private storage failure');
        return id === problemId ? problem : null;
      } }),
    };
    if (name.endsWith('/workspaces/request')) return { requireSessionWorkspace: async (session: { user: { id: string } },
      input: { workspaceId: string; permissions: string }) => {
      authorityReads += 1;
      assert.equal(session.user.id, 'viewer');
      assert.equal(input.workspaceId, problem.workspaceId, 'a foreign request header never chooses problem authority');
      assert.equal(input.permissions, 'canRead');
      if (!authorized) return { response: jsonError('Forbidden', 403) };
      return { workspace: { workspaceId: foreignScope ? 'foreign-workspace' : problem.workspaceId,
        status: active ? 'active' : 'archived', permissions: { canRead } } };
    } };
    throw new Error(`Unexpected problem route dependency: ${name}`);
  }, compiled, compiled.exports);
  const read = (id = problemId) => compiled.exports.GET(new NextRequest(`http://localhost/api/files/operations/problems/${id}`, {
    headers: { 'x-workspace-id': 'foreign-workspace' },
  }), { params: Promise.resolve({ problemId: id }) });
  const response = await read();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.problem, { problemId, workspaceId: problem.workspaceId, kind: problem.kind, selections: problem.selections,
    errorCode: problem.errorCode, createdAt: 1, updatedAt: 2 });
  assert.equal(JSON.stringify(body).includes('private'), false);
  assert.equal(JSON.stringify(body).includes('Private'), false);
  authenticated = false;
  const beforeUnauthorized = reads;
  const unauthorized = await read();
  assert.equal(unauthorized.status, 401); assert.equal(reads, beforeUnauthorized);
  assert.equal(unauthorized.headers.get('Cache-Control'), 'no-store');
  authenticated = true; limited = true;
  assert.equal((await read()).status, 429); assert.equal(reads, beforeUnauthorized);
  limited = false;
  const beforeUnknown = authorityReads;
  assert.equal((await read('unknown_problem_1234567890')).status, 404);
  assert.equal(authorityReads, beforeUnknown, 'an unknown problem has no workspace to authorize');
  authorized = false;
  assert.equal((await read()).status, 403);
  authorized = true; canRead = false;
  assert.equal((await read()).status, 403);
  canRead = true; foreignScope = true;
  assert.equal((await read()).status, 403);
  foreignScope = false; active = false;
  assert.equal((await read()).status, 403);
  active = true; storageUnavailable = true;
  const unavailable = await read();
  assert.equal(unavailable.status, 500);
  assert.equal(unavailable.headers.get('Cache-Control'), 'no-store');
  assert.equal(JSON.stringify(await unavailable.json()).includes('Private'), false);
  console.log('workspace path problem route: current scoped read permission, active workspace, private field projection and no-store passed');
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
