import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';
import type { SqlConnection } from '../app/lib/db';
import type { FileNode } from '../app/lib/files/types';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import { withNativeWorkspaceFileRead } from '../app/lib/collaboration/workspace-native-file-read';
import type * as Metadata from '../app/lib/files/workspace-file-metadata';
import type * as InfoRoute from '../app/api/files/info/route';

/** Execute the real route/enrichment source with only its external boundaries
 * replaced. This is a checkout-contract unit test; actual PG concurrency is
 * covered separately by file-guest-access-test's twelve simultaneous requests. */
async function sourceModule<T>(relative: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(relative), require = createRequire(filename);
  const javascript = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  new Function('require', 'exports', javascript)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), exports);
  return exports as T;
}

async function fixture(failAnnotations = false) {
  const workspace: WorkspaceContext = { workspaceId: 'info-connection-workspace', organizationId: null, workspaceType: 'personal',
    rootPath: '/no-physical-info-read', status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: false, canDelete: false, canManageWorkspace: false, canCreatePublicLinks: false, canRunAgent: false } };
  const doc = createPlainTextYDoc('Native Info checkout fixture');
  const state: PersistedCollaborationState = { documentId: 'info-connection-document', workspaceId: workspace.workspaceId,
    organizationId: null, path: 'note.md', lifecycleGeneration: 1, representation: 'plain_text', schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 7, persistedAt: 100,
    checkpointSequence: 7, checkpointedAt: null, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
  doc.destroy();
  const observations = { checkouts: 0, extraCheckouts: 0, statements: 0, closes: 0, commits: 0, rollbacks: 0, physicalReads: 0 };
  const annotationError = new Error('Owned annotation read failure.');
  const deniedCheckout = async () => { observations.extraCheckouts++; throw new Error('Enrichment must reuse the held native read connection.'); };
  const metadata = await sourceModule<typeof Metadata>('app/lib/files/workspace-file-metadata.ts', {
    '@/app/lib/db': { openDb: deniedCheckout },
    '../workspaces/request-principal': {}, '../collaboration/lifecycle-transaction': {},
    '../collaboration/workspace-document-catalogue': {}, '../workspaces/path-guard': {},
    '../filesystem/file-version': {}, './workspace-mutation-lock': {}, './workspace-side-effect-writer-fence': {},
    './collaboration-repository/transaction': { withFileCollaborationReadSnapshot: deniedCheckout },
  });
  const openConnection = async (): Promise<SqlConnection> => {
    observations.checkouts++; let active = false, closed = false;
    return {
      run: async sql => {
        assert.equal(closed, false);
        if (sql.startsWith('BEGIN')) { assert.equal(active, false); active = true; }
        else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          assert(active); active = false;
          if (sql === 'COMMIT') observations.commits++; else observations.rollbacks++;
        } else { assert(active); assert.match(sql, /^SET LOCAL/u); }
      },
      get: async sql => { assert(active); assert.match(sql, /pg_advisory_xact_lock_shared/u); return undefined; },
      all: async (sql, values) => {
        assert(active); assert.equal(closed, false); observations.statements++;
        assert.match(sql, /LEFT JOIN workspace_file_metadata/u); assert.match(sql, /LEFT JOIN workspace_file_user_states/u);
        assert.deepEqual(values, [workspace.workspaceId, ['note.md'], 'info-reader']);
        if (failAnnotations) throw annotationError;
        return [{ path: 'note.md', title: 'Atomic title', is_favorite: 1, pinned_at: 123 }];
      },
      close: async () => { assert.equal(active, false); assert.equal(closed, false); closed = true; observations.closes++; },
    };
  };
  const errors: unknown[] = [];
  const route = await sourceModule<typeof InfoRoute>('app/api/files/info/route.ts', {
    '@/app/lib/filesystem/workspace-files': { getFileStats: async () => { observations.physicalReads++; assert.fail('Native Info must not read a projection.'); } },
    '@/app/lib/files/workspace-file-metadata': metadata,
    '@/app/lib/workspaces/request': {
      requireRequestWorkspace: async () => ({ workspace, session: { user: { id: 'info-reader' } } }),
      workspaceFileOptions: () => assert.fail('Native Info must not request physical file options.'),
    },
    '@/app/lib/api/route-helpers': {
      jsonSuccess: (payload: Record<string, unknown>, init?: ResponseInit) => NextResponse.json({ success: true, ...payload }, init),
      jsonError: (error: string, status: number) => NextResponse.json({ success: false, error }, { status }),
      jsonServerError: (_scope: string, error: unknown, message: string) => { errors.push(error); return NextResponse.json({ success: false, error: message }, { status: 500 }); },
    },
    '@/app/lib/collaboration/workspace-native-file-read': {
      withNativeWorkspaceFileRead: <T>(input: Parameters<typeof withNativeWorkspaceFileRead>[0], consume: Parameters<typeof withNativeWorkspaceFileRead<T>>[1]) =>
        withNativeWorkspaceFileRead(input, consume, { openConnection,
          readCatalogue: async () => [{ id: state.documentId, lineage_id: 'info-connection-lineage', path: state.path,
            workspace_id: state.workspaceId, organization_id: null, status: 'active', state_version: 7,
            yjs_state_lifecycle: 'initialized', has_persisted_state: true, has_state_history: false,
            lifecycle_generation: 1, authority: 'initialized', state_status: 'active', state_path: state.path,
            state_workspace_id: state.workspaceId, state_organization_id: null }],
          loadState: async () => state,
        }),
    },
  });
  return { observations, errors, annotationError, metadata, workspace,
    info: () => route.GET(new NextRequest('http://localhost/api/files/info?path=note.md')) };
}

test('twelve simultaneous actual Info route/enrichment calls use exactly one held checkout each', async () => {
  const f = await fixture();
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.info()));
  for (const response of responses) {
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const { data } = await response.json();
    assert.equal(data.title, 'Atomic title'); assert.equal(data.isFavorite, true); assert.equal(data.pinnedAt, 123);
    assert.equal(data.metadataTarget.kind, 'native_file'); assert.equal(data.metadataTarget.documentId, 'info-connection-document');
  }
  assert.deepEqual(f.observations, { checkouts: 12, extraCheckouts: 0, statements: 12, closes: 12, commits: 12, rollbacks: 0, physicalReads: 0 });
  assert.deepEqual(f.errors, []);
});

test('annotation read failure rolls back and closes the original native checkout without acquiring another', async () => {
  const f = await fixture(true);
  assert.equal((await f.info()).status, 500); assert.deepEqual(f.errors, [f.annotationError]);
  assert.deepEqual(f.observations, { checkouts: 1, extraCheckouts: 0, statements: 1, closes: 1, commits: 0, rollbacks: 1, physicalReads: 0 });
});

test('connection-aware enrichment preserves exact paths and binds an absent user without personal state', async () => {
  const f = await fixture(), nodes: FileNode[] = [{ name: ' spaced.md ', path: ' spaced.md ', type: 'file' }];
  let statements = 0;
  const enriched = await f.metadata.enrichWorkspaceFileNodes({ nodes, workspace: f.workspace }, { all: async (_sql, values) => {
    statements++; assert.deepEqual(values, [f.workspace.workspaceId, [' spaced.md '], null]);
    return [{ path: ' spaced.md ', title: 'Exact spaced title', is_favorite: 0, pinned_at: null }];
  } });
  assert.equal(statements, 1); assert.equal(enriched[0].path, ' spaced.md '); assert.equal(enriched[0].title, 'Exact spaced title');
  assert.equal(enriched[0].isFavorite, false); assert.equal(enriched[0].pinnedAt, null); assert.equal(f.observations.extraCheckouts, 0);
});
