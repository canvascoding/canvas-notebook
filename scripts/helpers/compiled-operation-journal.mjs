import { isDeepStrictEqual } from 'node:util';

export const compiledOperationCases = Object.freeze(['rest', 'sdk'].flatMap(mode =>
  ['copy', 'move', 'delete'].map(kind => Object.freeze({ mode, kind }))));

/** Both profiles are required for acceptance; neither is a fallback for the other. */
export function compiledOperationProfile(flag) {
  if (flag === undefined) return Object.freeze({ name: 'incoming-links', incomingLinks: true, incomingLinkGroups: 4 });
  if (flag === '--minimal') return Object.freeze({ name: 'minimal', incomingLinks: false, incomingLinkGroups: 0 });
  throw new Error('Unknown compiled operation profile.');
}

const fail = () => { throw new Error('Compiled operation journal is outside its owned fixture.'); };
const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function ownedContext(context) {
  if (!record(context) || !Array.isArray(context.workspaces) || context.workspaces.length !== 2
    || new Set(context.workspaces).size !== 2 || context.workspaces.some(id => typeof id !== 'string' || !/^ws_[a-f0-9-]{36}$/u.test(id))
    || typeof context.nonce !== 'string' || !/^[a-f0-9-]{36}$/u.test(context.nonce)) fail();
  return context;
}

export function compiledOperationStatusRequests(context) {
  const { workspaces: [source, destination], nonce } = ownedContext(context);
  return compiledOperationCases.map(({ kind, mode }) => ({ kind, mode,
    route: '/api/documents/' + kind,
    body: { apiVersion: 1, action: 'status', operationId: `compiled-${kind}-${mode}-${nonce}`,
      ...(kind === 'copy' ? { sourceWorkspaceId: source, destinationWorkspaceId: destination } : { workspaceId: destination }) },
  }));
}

/** Validate only this nonce-owned test journal. This supplies no app authority
 * and performs no mutation, status retry or automatic recovery. */
export function validateCompiledOperationJournal(value, context, complete = false) {
  const { workspaces: [source, destination], nonce } = ownedContext(context);
  if (!Array.isArray(value) || value.length > 6 || complete && value.length !== 6) fail();
  const seen = new Set();
  for (const row of value) {
    if (!record(row) || !isDeepStrictEqual(Object.keys(row).sort(), ['kind', 'mode', 'rest', 'sdk'])
      || !compiledOperationCases.some(item => item.kind === row.kind && item.mode === row.mode)
      || !record(row.sdk) || !record(row.rest)) fail();
    const pair = row.kind + ':' + row.mode;
    if (seen.has(pair)) fail(); seen.add(pair);
    const operation = `compiled-${row.kind}-${row.mode}-${nonce}`, plan = row.sdk.plan_id;
    if (typeof plan !== 'string' || !/^[a-f0-9]{64}$/u.test(plan)) fail();
    const from = row.mode + '-move-source.md', to = row.mode + '-moved.md';
    const expectedSdk = row.kind === 'copy' ? {
      source_workspace_id: source, destination_workspace_id: destination,
      selections: [{ source_path: 'source-ü😀.md', destination_path: row.mode + '-copied.md' }],
      operation_id: operation, plan_id: plan,
    } : row.kind === 'move' ? { workspace_id: destination,
      selections: [{ source_path: from, destination_path: to }], operation_id: operation, plan_id: plan,
    } : { workspace_id: destination, path: row.mode + '-delete-source.md', operation_id: operation, plan_id: plan };
    const expectedRest = { apiVersion: 1, action: 'apply', operationId: operation, planId: plan,
      ...(row.kind === 'copy' ? { sourceWorkspaceId: source, destinationWorkspaceId: destination,
        selections: [{ sourcePath: 'source-ü😀.md', destinationPath: row.mode + '-copied.md' }] }
        : row.kind === 'move' ? { workspaceId: destination, selections: [{ sourcePath: from, destinationPath: to }] }
          : { workspaceId: destination, path: row.mode + '-delete-source.md' }),
    };
    if (!isDeepStrictEqual(row.sdk, expectedSdk) || !isDeepStrictEqual(row.rest, expectedRest)) fail();
  }
  return value;
}
