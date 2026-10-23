import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';

// Mechanical wire/schema/formatter tests only. No SQL principal, OAuth issuance,
// Owner execution, filesystem publication, HTTP server or SDK is simulated.
let groups = 0, completed = false, currentCase = 'module loading';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const operationId = 'copy-operation-00000001', planId = 'a'.repeat(64);
function request(action: 'preview' | 'apply' | 'recover' | 'status' = 'preview') {
  const slots = { api_version: 1, action, source_workspace_id: 'source-workspace', destination_workspace_id: 'destination-workspace' };
  return { ...slots, ...(action === 'preview' ? {} : { operation_id: operationId }),
    ...(action === 'apply' || action === 'recover' ? { plan_id: planId } : {}),
    ...(action === 'status' ? {} : { selections: [{ source_path: 'notes/a.md', destination_path: 'copied/a.md' }] }) };
}
function previewDto(previousTargetLiteral = 'target.md') {
  return { apiVersion: 1, action: 'preview', preview: { version: 4, kind: 'native-copy',
    sourceWorkspaceId: 'source-workspace', destinationWorkspaceId: 'destination-workspace', planId, readiness: 'ready',
    pathMappings: [{ sourceWorkspaceId: 'source-workspace', sourcePath: 'notes/a.md', destinationWorkspaceId: 'destination-workspace',
      destinationPath: 'copied/a.md', sourceKind: 'file', sourceIdentity: `native-copy-preview:${'b'.repeat(64)}` },
    { sourceWorkspaceId: 'source-workspace', sourcePath: 'notes/empty', destinationWorkspaceId: 'destination-workspace',
      destinationPath: 'copied/empty', sourceKind: 'directory', sourceIdentity: `native-copy-preview:${'c'.repeat(64)}` }],
    linkEdits: [{ sourcePathBefore: 'notes/a.md', sourcePathAfter: 'copied/a.md', previousTargetLiteral, nextTargetLiteral: 'copied-target.md' }],
    coverage: { complete: false, omittedSources: [], unresolvedLinks: [{ sourcePath: 'old.md', targetLiteral: 'missing.md', status: 'missing' }] },
    linkAssessment: { version: 1, complete: true, warnings: [{ workspaceId: 'source-workspace', sourcePath: 'old.md',
      targetLiteral: 'missing.md', status: 'missing', reason: 'unaffected-existing-link' }], blockers: [] }, issues: [] } };
}
function executionDto(action: 'apply' | 'recover' = 'apply') {
  return { apiVersion: 1, action, execution: { operationId, planId, status: 'needs_recovery',
    completedSteps: ['copy-path:0'], pendingSteps: ['copy-completion'], errorCode: 'NATIVE_COPY_COMMIT_UNCONFIRMED' as string | null },
  copied: [] as string[], alreadyKnown: false };
}
function statusDto(confirmed: boolean) {
  return { apiVersion: 1, action: 'status', operation: { operationId, planId, revision: 3,
    journal: { status: 'completed', phase: 'completed', expectedStepCount: 2, recordedStepCount: 2, appliedStepCount: 2, intentStepCount: 0,
      createdAt: 100, updatedAt: 200, errorCode: null as string | null },
    completion: confirmed ? { status: 'confirmed', historical: true, copiedPaths: ['copied/a.md'] }
      : { status: 'not_confirmed' } } };
}
function deeplyFrozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value)); for (const item of Object.values(value)) deeplyFrozen(item);
}
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function rawEnvelope(body: unknown) { return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body }; }
function exactRequestBytes(bytes: number) {
  const selections = Array.from({ length: 64 }, (_, index) => ({ source_path: `s-${index}`, destination_path: `d-${index}` }));
  const value = { ...request(), selections }; let remaining = bytes - jsonBytes(value); assert(remaining >= 0);
  for (const item of selections) for (const field of ['source_path', 'destination_path'] as const) {
    const count = Math.min(remaining, 1024 - item[field].length); item[field] += 'x'.repeat(count); remaining -= count;
  }
  assert.equal(remaining, 0); assert.equal(jsonBytes(value), bytes); return value;
}

export async function mcpServerWorkspaceCopyContractTest(): Promise<void> {
  const savedBase = process.env.BASE_URL, savedAuthBase = process.env.BETTER_AUTH_BASE_URL;
  process.env.BASE_URL = 'https://copy-wire.example.test'; process.env.BETTER_AUTH_BASE_URL = process.env.BASE_URL;
  try {
    const { decodeDirectMcpWorkspaceCopyRequestV1: decode, encodeDirectMcpWorkspaceCopyResultV1: encode,
      formatDirectMcpWorkspaceCopyResult: format, formatDirectMcpWorkspaceCopyError: formatError,
      workspaceCopyFailureV1: failure, normalizePublicCopyErrorCode: normalize, WorkspaceCopyToolError,
      WORKSPACE_COPY_REQUEST_MAX_BYTES: requestCap, WORKSPACE_COPY_TOOL_RESULT_MAX_BYTES: resultCap,
      DIRECT_MCP_WORKSPACE_COPY_INPUT_SCHEMA_V1: inputSchema, DIRECT_MCP_WORKSPACE_COPY_OUTPUT_SCHEMA_V1: outputSchema } =
      await import('../app/lib/mcp/server/workspace-copy-tool-contract');
    const { DirectMcpAuthorizationError } = await import('../app/lib/mcp/server/access-token-verifier');
    const { directMcpToolAuthorizationError } = await import('../app/lib/mcp/server/tool-auth');
    const { NativeCopyStatusNotFoundError } = await import('../app/lib/files/workspace-operation-native-copy-status');
    const { NativeCopyOperationNotFoundError } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { NativeCopyRequestTooLargeError } = await import('../app/lib/files/workspace-operation-native-copy-request-budget');
    const { WorkspaceOperationManagedCopyPlanV4Error } = await import('../app/lib/files/workspace-operation-managed-copy-plan-v4');
    const error = (code: string, status?: number, selected?: string) => (value: unknown) => {
      assert(value instanceof WorkspaceCopyToolError); assert.equal(value.code, code);
      if (status !== undefined) assert.equal(value.status, status);
      if (selected !== undefined) assert.equal(value.operationId, selected); return true;
    };
    const invalid = (value: unknown) => assert.throws(() => decode(value), error('INVALID_REQUEST', 400));
    const check = (name: string, operation: () => void) => { currentCase = name; operation(); groups++; console.log(`PASS Copy wire ${groups}: ${name}`); };

    check('four exact actions detach/freeze data and retain explicit caller operation/plan IDs', () => {
      for (const action of ['preview', 'apply', 'recover', 'status'] as const) {
        const wire = request(action), selected = decode(wire); deeplyFrozen(selected);
        assert.equal(selected.apiVersion, 1); assert.equal(selected.action, action);
        assert.equal(selected.sourceWorkspaceId, wire.source_workspace_id); assert.equal(selected.destinationWorkspaceId, wire.destination_workspace_id);
        if (selected.action === 'status') assert.deepEqual(Object.keys(selected).sort(), ['action', 'apiVersion', 'destinationWorkspaceId', 'operationId', 'sourceWorkspaceId']);
        else { assert.equal(selected.renameOnCollision, false); assert.deepEqual(selected.selections, [{ sourcePath: 'notes/a.md', destinationPath: 'copied/a.md' }]); }
        if (selected.action !== 'preview') assert.equal(selected.operationId, operationId);
        if (selected.action === 'apply' || selected.action === 'recover') assert.equal(selected.planId, planId);
      }
      const wire = { ...request('preview'), selections: [{ source_path: 'A/Überblick 😀.md', destination_path: 'B/Überblick 😀.md' }],
        rename_on_collision: true, destination_directory: '' };
      const selected = decode(wire); assert(selected.action === 'preview'); assert.equal(selected.destinationDirectory, '');
      assert.equal(selected.renameOnCollision, true); wire.selections[0].source_path = 'changed.md'; wire.rename_on_collision = false;
      assert.equal(selected.selections[0].sourcePath, 'A/Überblick 😀.md'); assert.equal(selected.renameOnCollision, true);
      assert.throws(() => Reflect.apply(Array.prototype.push, selected.selections, [{}]));
      for (const action of ['apply', 'recover'] as const) {
        const mutation = decode({ ...request(action), rename_on_collision: false });
        assert(mutation.action === 'apply' || mutation.action === 'recover'); assert.equal(mutation.action, action);
        assert.equal(mutation.renameOnCollision, false); assert.equal(mutation.operationId, operationId); assert.equal(mutation.planId, planId);
      }
      assert.equal(inputSchema.oneOf.length, 4); assert.equal(outputSchema.oneOf.length, 5);
      deeplyFrozen(inputSchema); deeplyFrozen(outputSchema);
    });

    check('supplied malformed versions/actions/unknown fields never select a legacy branch', () => {
      const missing = { ...request() } as Record<string, unknown>; delete missing.api_version; invalid(missing);
      for (const api_version of [undefined, null, 0, 2, '1', true]) invalid({ ...request(), api_version });
      for (const action of [undefined, null, '', 'execute', 'preview ', { toString: 'not callable' }]) invalid({ ...request(), action });
      for (const extra of ['origin', 'mcpPrincipal', 'request', 'actor', 'rootPath', 'plan', 'apiVersion']) invalid({ ...request(), [extra]: {} });
      invalid({ ...request('status'), selections: [] }); invalid({ ...request('status'), plan_id: planId });
      for (const action of ['apply', 'recover'] as const) {
        assert.throws(() => decode({ ...request(action), rename_on_collision: true }), error('INVALID_REQUEST', 400, operationId));
      }
      invalid({ ...request(), operation_id: operationId }); invalid({ ...request(), rename_on_collision: undefined });
      invalid({ ...request(), destination_directory: '.' }); invalid({ ...request(), destination_directory: null });
      for (const operation_id of ['', 'short', 'a'.repeat(129), '_'.repeat(16), 'a'.repeat(15) + '.', operationId + '\n']) invalid({ ...request('apply'), operation_id });
      for (const plan_id of ['', 'A'.repeat(64), 'a'.repeat(63), planId + '0', undefined]) invalid({ ...request('recover'), plan_id });
      assert.equal(decode({ ...request('status'), operation_id: 'a'.repeat(16) }).action, 'status');
      assert.equal(decode({ ...request('status'), operation_id: 'a'.repeat(128) }).action, 'status');
      assert.throws(() => decode({ ...request('apply'), api_version: 2 }), error('INVALID_REQUEST', 400, operationId));
    });

    check('hostile reflection/getters/sparse arrays and Unicode are rejected with zero input traps', () => {
      let traps = 0;
      const handler: ProxyHandler<object> = { get() { traps++; throw new Error('get trap'); },
        ownKeys() { traps++; throw new Error('ownKeys trap'); }, getPrototypeOf() { traps++; throw new Error('prototype trap'); },
        getOwnPropertyDescriptor() { traps++; throw new Error('descriptor trap'); } };
      invalid(new Proxy(request(), handler));
      const revoked = Proxy.revocable(request(), handler); revoked.revoke(); invalid(revoked.proxy);
      invalid({ ...request(), selections: [new Proxy({ source_path: 'a.md', destination_path: 'b.md' }, handler)] });
      invalid({ ...request(), selections: new Proxy([{ source_path: 'a.md', destination_path: 'b.md' }], handler) });
      const getter = request(); Object.defineProperty(getter, 'action', { enumerable: true, get() { traps++; throw new Error('getter'); } }); invalid(getter);
      const nested = { source_path: 'a.md', destination_path: 'b.md' };
      Object.defineProperty(nested, 'source_path', { enumerable: true, get() { traps++; throw new Error('nested getter'); } });
      invalid({ ...request(), selections: [nested] });
      invalid({ ...request(), selections: new Array(1) });
      const augmented = [{ source_path: 'a.md', destination_path: 'b.md' }];
      Object.defineProperty(augmented, 'map', { value: () => { traps++; throw new Error('array method'); }, enumerable: true });
      invalid({ ...request(), selections: augmented }); invalid(Object.assign(Object.create(null), request()));
      const reserved = request(); Object.defineProperty(reserved, '__proto__', { value: {}, enumerable: true }); invalid(reserved);
      for (const source_path of ['', '/absolute.md', 'a//b.md', 'a/../b.md', './a.md', 'a\\b.md', 'a/\u0000b', 'a/\ud800', 'a/\udfff', 'x'.repeat(1025)]) {
        invalid({ ...request(), selections: [{ source_path, destination_path: 'b.md' }] });
      }
      for (const source_workspace_id of ['', 'x'.repeat(201), ' source', 'source\t', 'source-\ud800']) invalid({ ...request(), source_workspace_id });
      assert.equal(traps, 0);
      const rows = Array.from({ length: 1000 }, (_, index) => ({ source_path: `s${index}`, destination_path: `d${index}` }));
      assert.equal(decode({ ...request(), selections: rows }).action, 'preview');
      assert.throws(() => decode({ ...request(), selections: [...rows, rows[0]] }), error('COPY_TOO_LARGE', 413));
      invalid({ ...request(), selections: [] });
    });

    check('exact escaped UTF-8 request budget rejects overflow before serializer/copy expansion', () => {
      assert.equal(requestCap, 65536);
      const exact = exactRequestBytes(requestCap); assert.equal(decode(exact).action, 'preview');
      assert.throws(() => decode(exactRequestBytes(requestCap + 1)), error('COPY_TOO_LARGE', 413));
      const escaped = exactRequestBytes(requestCap); escaped.selections[0].source_path = escaped.selections[0].source_path.slice(0, -1) + '"';
      assert.equal(jsonBytes(escaped), requestCap + 1); assert.throws(() => decode(escaped), error('COPY_TOO_LARGE', 413));
      const unicode = exactRequestBytes(requestCap - 1); unicode.selections[0].source_path = unicode.selections[0].source_path.slice(0, -1) + '漢';
      assert.equal(jsonBytes(unicode), requestCap + 1); assert.throws(() => decode(unicode), error('COPY_TOO_LARGE', 413));
    });

    check('complete public Preview preserves every mapping/link/coverage entry and rejects private or accessor fields', () => {
      const input = previewDto(), original = structuredClone(input), encoded = encode(input);
      assert.deepEqual(encoded, original); deeplyFrozen(encoded);
      const response = format(input); assert.deepEqual(response.structuredContent, original);
      assert.equal(response.content.length, 1); const text = response.content[0]; assert(text); assert.equal(text.type, 'text');
      if (text.type !== 'text') assert.fail('Expected JSON text.'); assert.deepEqual(JSON.parse(text.text), original);
      assert(jsonBytes(response) <= resultCap); input.preview.pathMappings[0].destinationPath = 'changed.md';
      assert.deepEqual(response.structuredContent, original);
      for (const key of ['plan', 'stage', 'origin', 'rootPath', 'recipes', 'previewContents']) {
        assert.throws(() => encode({ ...original, [key]: {} }), error('COPY_UNAVAILABLE', 503));
        assert.throws(() => encode({ ...original, preview: { ...original.preview, [key]: {} } }), error('COPY_UNAVAILABLE', 503));
      }
      let getters = 0; const hostile = previewDto();
      Object.defineProperty(hostile.preview, 'coverage', { enumerable: true, get() { getters++; throw new Error('result getter'); } });
      assert.throws(() => encode(hostile), error('COPY_UNAVAILABLE', 503)); assert.equal(getters, 0);
      assert.throws(() => encode({ ...original, preview: { ...original.preview, coverage: { ...original.preview.coverage, complete: true } } }), error('COPY_UNAVAILABLE', 503));
    });

    check('execution/status use fixed codes and distinguish journal labels, confirmed history and both 404 meanings', () => {
      for (const action of ['apply', 'recover'] as const) {
        const value = encode(executionDto(action)); assert(value.action === action); assert(value.action === 'apply' || value.action === 'recover');
        assert.equal(value.execution.errorCode, 'COPY_OUTCOME_UNCONFIRMED'); assert.equal(value.execution.operationId, operationId);
        assert.deepEqual(Object.keys(value).sort(), ['action', 'alreadyKnown', 'apiVersion', 'copied', 'execution']);
      }
      const done = executionDto(); done.execution.status = 'complete'; done.execution.pendingSteps = []; done.execution.errorCode = null; done.copied = ['copied/a.md'];
      assert.equal(encode(done).action, 'apply');
      assert.throws(() => encode({ ...done, execution: { ...done.execution, pendingSteps: ['copy-completion'] } }), error('COPY_UNAVAILABLE', 503, operationId));
      const notConfirmed = encode(statusDto(false)); assert.equal(notConfirmed.action, 'status');
      if (notConfirmed.action !== 'status') assert.fail(); assert.equal(notConfirmed.operation.journal.status, 'completed');
      assert.deepEqual(notConfirmed.operation.completion, { status: 'not_confirmed' });
      const confirmed = encode(statusDto(true)); assert.equal(confirmed.action, 'status');
      if (confirmed.action !== 'status') assert.fail(); assert.deepEqual(confirmed.operation.completion, { status: 'confirmed', historical: true, copiedPaths: ['copied/a.md'] });
      const unknown = statusDto(false); unknown.operation.journal.errorCode = 'secret-source-path-or-unknown-code';
      const redacted = encode(unknown); assert(redacted.action === 'status'); assert.equal(redacted.operation.journal.errorCode, 'COPY_UNAVAILABLE');
      for (const code of ['__proto__', 'constructor', 'prototype', '', 'postgres-private-error']) assert.equal(normalize(code), 'COPY_UNAVAILABLE');
      const status404 = failure(new NativeCopyStatusNotFoundError(), operationId), recover404 = failure(new NativeCopyOperationNotFoundError(), operationId);
      assert.equal(status404.status, 404); assert.equal(status404.body.code, 'COPY_STATUS_NOT_FOUND');
      assert.equal(recover404.status, 404); assert.equal(recover404.body.code, 'COPY_OPERATION_NOT_FOUND');
      assert.equal(status404.body.operationId, operationId); assert.equal(recover404.body.operationId, operationId);
      // Required integration delta, deliberately absent from the original
      // frozen wire source: Root adds this mapping with the shared byte guard.
      const canonical = failure(new NativeCopyRequestTooLargeError(), operationId);
      assert.equal(canonical.status, 413); assert.equal(canonical.body.code, 'COPY_TOO_LARGE');
      const importRequired = new WorkspaceOperationManagedCopyPlanV4Error('MANAGED_COPY_PLAN_IMPORT_REQUIRED');
      assert.match(importRequired.message, /imported into the notebook/u);
      const blocked = failure(importRequired, operationId);
      assert.equal(blocked.status, 409);
      assert.deepEqual(blocked.body, { apiVersion: 1, success: false, code: 'COPY_NATIVE_REQUIRED', operationId });
      assert.deepEqual(formatError(importRequired, operationId).structuredContent, blocked.body);
    });

    check('actual authorization errors retain the original OAuth challenge while only bounded public error data is emitted', () => {
      for (const status of [401, 403, 503] as const) {
        const authorization = new DirectMcpAuthorizationError(status === 403 ? 'insufficient_scope' : status === 503 ? 'authorization_unavailable' : 'invalid_token',
          status, 'private source excerpt never emitted', { challengeError: status === 403 ? 'insufficient_scope' : 'invalid_token', scope: 'knowledge:write' });
        const challenge = authorization.challenge, original = directMcpToolAuthorizationError(authorization, 'knowledge:write');
        const wrapper = new Error('Private cleanup wrapper', { cause: authorization });
        const response = formatError(wrapper, operationId);
        assert.deepEqual(response._meta, original._meta); assert.equal(authorization.challenge, challenge); assert.equal(response.isError, true);
        const body = response.structuredContent; assert(body && typeof body === 'object');
        assert.deepEqual(body, { apiVersion: 1, success: false, code: status === 401 ? 'AUTHENTICATION_REQUIRED' : status === 403 ? 'ACCESS_DENIED' : 'COPY_UNAVAILABLE', operationId });
        assert.equal(JSON.stringify(response).includes('private source'), false); assert.equal(JSON.stringify(response).includes('Private cleanup'), false);
        assert(jsonBytes(response) <= resultCap);
      }
      const authorization = new DirectMcpAuthorizationError('invalid_token', 401, 'not emitted');
      // Mechanical formatter-boundary fault only: preserve the actual class
      // and its exact now-oversized metadata instead of inventing a fake grant.
      Object.defineProperty(authorization, 'challenge', { value: 'x'.repeat(resultCap), enumerable: true });
      assert.throws(() => formatError(authorization, operationId), error('COPY_OUTPUT_TOO_LARGE', 413, operationId));
    });

    check('whole escaped MCP envelope has a strict 1MiB boundary and keeps a known operation on late output failure', () => {
      assert.equal(resultCap, 1024 * 1024);
      const empty = encode(previewDto('')), overhead = jsonBytes(rawEnvelope(empty));
      const count = Math.floor((resultCap - overhead) / 6); assert(count > 100_000);
      const fits = previewDto('"'.repeat(count)), tooLarge = previewDto('"'.repeat(count + 1));
      assert(jsonBytes(fits) < resultCap && jsonBytes(tooLarge) < resultCap, 'Both DTOs fit; the whole repeated/escaped envelope is decisive.');
      const actual = format(fits); assert.equal(jsonBytes(actual), overhead + count * 6); assert(jsonBytes(actual) <= resultCap);
      assert.equal(jsonBytes(rawEnvelope(encode(tooLarge))), overhead + (count + 1) * 6);
      assert.throws(() => format(tooLarge), error('COPY_OUTPUT_TOO_LARGE', 413));
      const known = executionDto(); known.execution.completedSteps = Array.from({ length: 9000 }, (_, index) => `copy-link:${index.toString(16).padStart(64, '0')}`);
      assert(jsonBytes(known) < resultCap); assert.equal(encode(known).action, 'apply');
      assert.throws(() => format(known), error('COPY_OUTPUT_TOO_LARGE', 413, operationId));
      const safe = formatError(new WorkspaceCopyToolError('COPY_OUTPUT_TOO_LARGE', operationId));
      assert.deepEqual(safe.structuredContent, { apiVersion: 1, success: false, code: 'COPY_OUTPUT_TOO_LARGE', operationId });
      assert(jsonBytes(safe) < 1024);
    });
  } finally {
    if (savedBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = savedBase;
    if (savedAuthBase === undefined) delete process.env.BETTER_AUTH_BASE_URL; else process.env.BETTER_AUTH_BASE_URL = savedAuthBase;
  }
  assert.equal(groups, 8); completed = true;
  console.log(`MCP Copy wire: ${groups}/8 mechanical contract/formatter families; no runtime authority or Copy execution claim.`);
}

void mcpServerWorkspaceCopyContractTest().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error('MCP Copy wire failure:', { currentCase, groups, name: error instanceof Error ? error.name : typeof error,
    code: typeof code === 'string' && /^[A-Za-z0-9_]{1,96}$/u.test(code) ? code : undefined,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1).filter(line => line.trim().startsWith('at ')).slice(0, 6) : undefined });
  process.exitCode = 1;
});
