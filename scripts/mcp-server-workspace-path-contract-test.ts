import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';

// Pure decoder/schema/formatter regression only. No principal, SQL, owner,
// HTTP transport, OAuth issuance, filesystem or SDK acceptance is claimed.
let groups = 0, completed = false, currentCase = 'module loading';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const operationId = 'path-operation-00000001', planId = 'a'.repeat(64), batchId = 'b'.repeat(64);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const request = (kind: 'move' | 'delete', action: 'preview' | 'apply' | 'recover' | 'status' = 'preview'): Record<string, unknown> => ({
  api_version: 1, workspace_id: 'workspace', action,
  ...(action === 'preview' ? {} : { operation_id: operationId }),
  ...(action === 'apply' || action === 'recover' ? { plan_id: planId } : {}),
  ...(action === 'status' ? {} : kind === 'move' ? { selections: [{ source_path: 'notes/a.md', destination_path: 'moved/a.md' }] } : { path: 'notes/a.md' }),
});
const preview = (kind: 'move' | 'delete' = 'move') => ({ apiVersion: 1, action: 'preview', preview: {
  kind, workspaceId: 'workspace', planId, readiness: 'ready',
  paths: [{ sourcePath: 'notes/a.md', ...(kind === 'move' ? { destinationPath: 'moved/a.md' } : {}) }],
  linkChanges: { rewrites: kind === 'move' ? 2 : 0, unlinks: kind === 'delete' ? 2 : 0, affectedDocuments: 1 }, coverage: { complete: true },
} });
const operation = () => ({ operationId, batchId, planId, workspaceId: 'workspace',
  journal: { status: 'applied', phase: 'complete', completedActions: 1, totalActions: 1, createdAt: 100, updatedAt: 200, errorCode: null as string | null },
  execution: { receiptStatus: 'available', finalization: 'complete', steps: [{ key: 'path:0000', phase: 'path', kind: 'move',
    path: 'notes/a.md', destinationPath: 'moved/a.md', state: 'applied', openPath: 'moved/a.md' }] },
  completion: { status: 'confirmed', historical: true },
});
const result = (action: 'apply' | 'recover' | 'status' = 'status') => ({ apiVersion: 1, action, operation: operation(),
  ...(action === 'status' ? {} : { alreadyKnown: false }) });
const frozen = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value)); for (const child of Object.values(value)) frozen(child);
};

export async function mcpServerWorkspacePathContractTest(): Promise<void> {
  const previousBase = process.env.BASE_URL, previousAuth = process.env.BETTER_AUTH_BASE_URL;
  process.env.BASE_URL = 'https://path-wire.example.test'; process.env.BETTER_AUTH_BASE_URL = process.env.BASE_URL;
  try {
    const { decodeDirectMcpWorkspaceMoveRequestV1: move, decodeDirectMcpWorkspaceDeleteRequestV1: deletion,
      encodeDirectMcpWorkspacePathResultV1: encode, formatDirectMcpWorkspacePathResult: format,
      formatDirectMcpWorkspacePathError: formatError, workspacePathFailureV1: failure,
      normalizePublicWorkspacePathErrorCode: normalize, WorkspacePathToolError,
      WORKSPACE_PATH_REQUEST_MAX_BYTES: requestCap, WORKSPACE_PATH_TOOL_RESULT_MAX_BYTES: resultCap,
      DIRECT_MCP_WORKSPACE_MOVE_INPUT_SCHEMA_V1: moveSchema, DIRECT_MCP_WORKSPACE_DELETE_INPUT_SCHEMA_V1: deleteSchema,
      DIRECT_MCP_WORKSPACE_MOVE_OUTPUT_SCHEMA_V1: moveOutput, DIRECT_MCP_WORKSPACE_DELETE_OUTPUT_SCHEMA_V1: deleteOutput } =
      await import('../app/lib/mcp/server/workspace-path-tool-contract');
    const { DirectMcpAuthorizationError } = await import('../app/lib/mcp/server/access-token-verifier');
    const { directMcpToolAuthorizationError } = await import('../app/lib/mcp/server/tool-auth');
    const { WorkspaceFileLifecycleBusyError } = await import('../app/lib/files/workspace-file-lifecycle-guard');
    const error = (code: string, status: number, selected?: string) => (value: unknown): boolean => {
      assert(value instanceof WorkspacePathToolError); assert.equal(value.code, code); assert.equal(value.status, status);
      if (selected !== undefined) assert.equal(value.operationId, selected); return true;
    };
    const check = (name: string, callback: () => void): void => { currentCase = name; callback(); groups++; console.log(`PASS Path wire ${groups}: ${name}`); };
    check('both fixed tools expose four strict actions and detached frozen caller data', () => {
      for (const kind of ['move', 'delete'] as const) for (const action of ['preview', 'apply', 'recover', 'status'] as const) {
        const input = request(kind, action), actual = kind === 'move' ? move(input) : deletion(input); frozen(actual);
        assert.equal(actual.apiVersion, 1); assert.equal(actual.workspaceId, 'workspace'); assert.equal(actual.action, action);
        if (actual.action !== 'preview') assert.equal(actual.operationId, operationId);
        if (actual.action === 'apply' || actual.action === 'recover') assert.equal(actual.planId, planId);
        if ('selections' in actual) {
          (input.selections as Array<{ source_path: string }>)[0].source_path = 'changed.md';
          assert.equal(actual.selections[0].sourcePath, 'notes/a.md');
        } else if ('path' in actual) { input.path = 'changed.md'; assert.equal(actual.path, 'notes/a.md'); }
        if (action === 'status') assert.deepEqual(Object.keys(actual).sort(), ['action', 'apiVersion', 'operationId', 'workspaceId']);
      }
    });
    check('unknown versions, actions, legacy and collision flags never fall back', () => {
      for (const decode of [move, deletion]) for (const supplied of [undefined, null, 0, 2, '1']) {
        assert.throws(() => decode({ ...request(decode === move ? 'move' : 'delete'), api_version: supplied }), error('INVALID_REQUEST', 400));
      }
      for (const kind of ['move', 'delete'] as const) {
        const decode = kind === 'move' ? move : deletion;
        for (const key of ['origin', 'actor', 'request', 'rootPath', 'rename_on_collision', 'destination_directory', 'ignore_missing', 'undo']) {
          assert.throws(() => decode({ ...request(kind, 'apply'), [key]: true }), error('INVALID_REQUEST', 400, operationId));
        }
        assert.throws(() => decode({ ...request(kind), action: 'undo' }), error('INVALID_REQUEST', 400));
        assert.throws(() => decode({ ...request(kind, 'status'), plan_id: planId }), error('INVALID_REQUEST', 400, operationId));
        for (const invalidId of ['_'.repeat(16), `${operationId}\n`, 'x'.repeat(129)]) {
          assert.throws(() => decode({ ...request(kind, 'recover'), operation_id: invalidId }), error('INVALID_REQUEST', 400));
        }
        assert.throws(() => decode({ ...request(kind, 'apply'), plan_id: 'A'.repeat(64) }), error('INVALID_REQUEST', 400, operationId));
      }
      assert.throws(() => move({ ...request('move'), path: 'extra.md' }), error('INVALID_REQUEST', 400));
      assert.throws(() => deletion({ ...request('delete'), selections: [] }), error('INVALID_REQUEST', 400));
    });
    check('hostile roots, nested getters, proxies, sparse arrays and cycles execute no traps', () => {
      let traps = 0;
      const proxy = new Proxy({}, { get() { traps++; throw new Error('trap'); }, ownKeys() { traps++; throw new Error('trap'); },
        getPrototypeOf() { traps++; throw new Error('trap'); } });
      const revoked = Proxy.revocable({}, {}); revoked.revoke();
      const getter = Object.defineProperty(request('move'), 'workspace_id', { enumerable: true, get() { traps++; throw new Error('getter'); } });
      for (const value of [proxy, revoked.proxy, getter, { ...request('move'), selections: [proxy] },
        { ...request('move'), selections: Array(1) }, { ...request('move'), selections: [{ source_path: 'a', destination_path: proxy }] }]) {
        assert.throws(() => move(value), error('INVALID_REQUEST', 400));
      }
      const cyclic = request('move'); cyclic.selections = [cyclic]; assert.throws(() => move(cyclic), error('INVALID_REQUEST', 400));
      assert.equal(traps, 0);
    });
    check('canonical path, ECMAScript trim, UTF16 and Unicode limits match the public contract', () => {
      const input = request('move');
      assert.equal(move({ ...input, workspace_id: '\u0085workspace' }).workspaceId, '\u0085workspace');
      for (const workspace_id of ['', ' workspace', 'workspace\ufeff', 'x'.repeat(201), '\ud800']) {
        assert.throws(() => move({ ...input, workspace_id }), error('INVALID_REQUEST', 400));
      }
      assert.equal(deletion({ ...request('delete'), path: ` ${'😀'.repeat(510)} ` }).action, 'preview');
      for (const path of ['', '.', '../a', 'a//b', 'a/./b', '/a', 'a\\b', 'a\n', '😀'.repeat(513), '\ud800']) {
        assert.throws(() => deletion({ ...request('delete'), path }), error('INVALID_REQUEST', 400));
      }
    });
    check('exact escaped UTF8 argument cap precedes cloning and preserves selected IDs on failure', () => {
      const exact = (maximum: number) => {
        const selections = Array.from({ length: 64 }, (_, index) => ({ source_path: `s-${index}`, destination_path: `d-${index}` }));
        const value = { ...request('move', 'apply'), selections }; let remaining = maximum - bytes(value);
        for (const selection of selections) for (const key of ['source_path', 'destination_path'] as const) {
          const added = Math.min(remaining, 1024 - selection[key].length); selection[key] += 'x'.repeat(added); remaining -= added;
        }
        assert.equal(remaining, 0); assert.equal(bytes(value), maximum); return value;
      };
      assert.equal(requestCap, 65536); move(exact(requestCap));
      assert.throws(() => move(exact(requestCap + 1)), error('PATH_TOO_LARGE', 413, operationId));
      assert.throws(() => move({ ...request('move'), selections: Array.from({ length: 1001 }, () => ({ source_path: 'a', destination_path: 'b' })) }), error('PATH_TOO_LARGE', 413));
      let captured: unknown; try { move({ ...request('move', 'apply'), origin: {} }); } catch (error) { captured = error; }
      assert.deepEqual(failure(captured).body, { apiVersion: 1, success: false, code: 'INVALID_REQUEST', operationId });
    });
    check('minimal previews and receipt completion are strict; journal finality is separate', () => {
      for (const kind of ['move', 'delete'] as const) { const input = preview(kind); const actual = encode(input); assert.deepEqual(actual, input); frozen(actual); }
      for (const action of ['apply', 'recover', 'status'] as const) { const value = result(action); assert.deepEqual(encode(value, operationId), value); }
      const uncertainHeader = result(); uncertainHeader.operation.journal.status = 'needs_recovery'; uncertainHeader.operation.journal.completedActions = 0;
      assert.equal((encode(uncertainHeader, operationId) as ReturnType<typeof result>).operation.completion.status, 'confirmed');
      const headerWithoutReceipt = { ...result(), operation: { ...operation(), completion: { status: 'not_confirmed' } } };
      assert.deepEqual(encode(headerWithoutReceipt, operationId), headerWithoutReceipt);
      const headerOnly = result(); headerOnly.operation.completion = { status: 'not_confirmed', historical: true };
      assert.throws(() => encode(headerOnly, operationId), error('PATH_UNAVAILABLE', 503, operationId));
      const invalidReceipt = result(); invalidReceipt.operation.execution.finalization = 'pending';
      assert.throws(() => encode(invalidReceipt, operationId), error('PATH_UNAVAILABLE', 503, operationId));
      for (const key of ['origin', 'plan', 'sourceEvidence', 'nativeIds', 'bytes']) {
        assert.throws(() => encode({ ...preview(), [key]: {} }), error('PATH_UNAVAILABLE', 503));
        const value = result(); assert.throws(() => encode({ ...value, operation: { ...value.operation, [key]: {} } }, operationId), error('PATH_UNAVAILABLE', 503, operationId));
      }
      assert.throws(() => encode({ ...preview(), preview: { ...preview().preview, kind: { toString: 'not callable' } } }), error('PATH_UNAVAILABLE', 503));
      assert.equal(moveSchema.oneOf.length, 4); assert.equal(deleteSchema.oneOf.length, 4);
      assert.equal(moveOutput.oneOf.length, 5); assert.equal(deleteOutput.oneOf.length, 5);
    });
    check('fixed errors distinguish absent status/recover and retain genuine OAuth challenge metadata', () => {
      assert.equal(failure(new WorkspacePathToolError('PATH_STATUS_NOT_FOUND', operationId)).status, 404);
      assert.equal(failure(new WorkspacePathToolError('PATH_OPERATION_NOT_FOUND', operationId)).body.code, 'PATH_OPERATION_NOT_FOUND');
      assert.equal(normalize('private arbitrary stored prose'), 'PATH_UNAVAILABLE');
      const redacted = result(); redacted.operation.journal.errorCode = 'private stored prose';
      const encoded = encode(redacted, operationId); assert(encoded.action !== 'preview'); assert.equal(encoded.operation.journal.errorCode, 'PATH_UNAVAILABLE');
      assert.equal(failure(new Error('private message')).body.code, 'PATH_UNAVAILABLE');
      assert.equal(failure(new AggregateError([new WorkspacePathToolError('PATH_CONFLICT'), new WorkspacePathToolError('PATH_OUTCOME_UNCONFIRMED')])).body.code, 'PATH_OUTCOME_UNCONFIRMED');
      for (const status of [401, 403, 503] as const) {
        const auth = new DirectMcpAuthorizationError(status === 403 ? 'insufficient_scope' : status === 503 ? 'authorization_unavailable' : 'invalid_token',
          status, 'private message must never escape', { challengeError: 'invalid_token', scope: 'knowledge:write' });
        const actual = formatError(new Error('private wrapper', { cause: auth }), operationId), original = directMcpToolAuthorizationError(auth, 'knowledge:write');
        assert.deepEqual(actual._meta, original._meta); assert.equal(actual.isError, true); assert.equal(JSON.stringify(actual).includes('private'), false);
        assert.deepEqual(actual.structuredContent, { apiVersion: 1, success: false, code: status === 401 ? 'AUTHENTICATION_REQUIRED' : status === 403 ? 'ACCESS_DENIED' : 'PATH_UNAVAILABLE', operationId });
      }
      const auth = new DirectMcpAuthorizationError('invalid_token', 401, 'not emitted');
      Object.defineProperty(auth, 'challenge', { value: 'x'.repeat(resultCap), enumerable: true });
      assert.throws(() => formatError(auth, operationId), error('PATH_OUTPUT_TOO_LARGE', 413, operationId));
    });
    check('real lifecycle Busy remains an explicit conflict in failures and stored recovery status', () => {
      const busy = new WorkspaceFileLifecycleBusyError();
      assert.equal(busy.status, 409); assert.equal(normalize(busy.code), 'PATH_BUSY');
      for (const code of [`${busy.code}_UNKNOWN`, busy.code.toLowerCase(), 'COLLABORATION_FILE_LIFECYCLE_BUSY private']) {
        assert.equal(normalize(code), 'PATH_UNAVAILABLE');
      }
      const expected = { apiVersion: 1, success: false, code: 'PATH_BUSY', operationId };
      for (const error of [busy, new Error('private lifecycle wrapper', { cause: busy })]) {
        assert.deepEqual(failure(error, operationId), { status: 409, body: expected });
        const wire = formatError(error, operationId);
        assert.equal(wire.isError, true); assert.deepEqual(wire.structuredContent, expected);
        assert.equal(wire.content.length, 1); assert.equal(wire.content[0].type, 'text');
        assert.deepEqual(JSON.parse((wire.content[0] as { text: string }).text), expected);
        assert.equal(JSON.stringify(wire).includes(busy.message), false);
        assert.equal(JSON.stringify(wire).includes('private lifecycle wrapper'), false);
      }
      const original = { ...result(), operation: { ...operation(),
        journal: { ...operation().journal, status: 'needs_recovery', phase: 'recovery',
          completedActions: 0, totalActions: 2, errorCode: busy.code },
        execution: { receiptStatus: 'not_started', finalization: 'pending', steps: [] },
        completion: { status: 'not_confirmed' },
      } };
      const encoded = encode(original, operationId); assert(encoded.action === 'status');
      assert.deepEqual(encoded, { ...original, operation: { ...original.operation,
        journal: { ...original.operation.journal, errorCode: 'PATH_BUSY' } } });
      assert.equal(original.operation.journal.errorCode, busy.code); frozen(encoded);
      const uncertain = Object.assign(new Error('private unconfirmed commit'), { code: 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED' });
      assert.deepEqual(failure(new AggregateError([busy, uncertain]), operationId), {
        status: 503, body: { ...expected, code: 'PATH_OUTCOME_UNCONFIRMED' },
      });
      const auth = new DirectMcpAuthorizationError('invalid_token', 401, 'private auth', { challengeError: 'invalid_token', scope: 'knowledge:write' });
      const challenged = formatError(new AggregateError([busy, uncertain, auth]), operationId);
      assert.deepEqual(challenged.structuredContent, { ...expected, code: 'AUTHENTICATION_REQUIRED' });
      assert.deepEqual(challenged._meta, directMcpToolAuthorizationError(auth, 'knowledge:write')._meta);
    });
    check('whole escaped MCP envelope has a strict 1MiB cap without trimming paths or receipts', () => {
      const empty = preview(); empty.preview.paths = Array.from({ length: 1000 }, (_, index) => ({ sourcePath: `s${index}`, destinationPath: `d${index}` }));
      const overhead = bytes({ content: [{ type: 'text', text: JSON.stringify(empty) }], structuredContent: empty });
      const fill = (count: number) => { const value = structuredClone(empty); let remaining = count;
        for (const path of value.preview.paths) for (const key of ['sourcePath', 'destinationPath'] as const) {
          const added = Math.min(remaining, 1024 - path[key]!.length); path[key] = path[key]! + '"'.repeat(added); remaining -= added;
        }
        assert.equal(remaining, 0); return value;
      };
      const count = Math.floor((resultCap - overhead) / 6), fits = fill(count), over = fill(count + 1);
      assert(bytes(fits) < resultCap && bytes(over) < resultCap); assert.equal(bytes(format(fits)), overhead + count * 6);
      assert(bytes(format(fits)) <= resultCap); assert.throws(() => format(over), error('PATH_OUTPUT_TOO_LARGE', 413));
      const emitted = format(result('recover'), operationId); assert.deepEqual(JSON.parse((emitted.content[0] as { text: string }).text), emitted.structuredContent);
    });
    assert.equal(groups, 9); completed = true;
    console.log(JSON.stringify({ test: 'mcp-server-workspace-path-contract', groups, scope: 'pure strict wire/schema/formatter only; no runtime authority or owner claim' }));
  } finally {
    if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase;
    if (previousAuth === undefined) delete process.env.BETTER_AUTH_BASE_URL; else process.env.BETTER_AUTH_BASE_URL = previousAuth;
  }
}
mcpServerWorkspacePathContractTest().catch(error => {
  console.error(JSON.stringify({ test: 'mcp-server-workspace-path-contract', failed: true, case: currentCase, groups,
    name: error instanceof Error ? error.name : 'Unknown', code: error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null }));
  process.exitCode = 1;
});
