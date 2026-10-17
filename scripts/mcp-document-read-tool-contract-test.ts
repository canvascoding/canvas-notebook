import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import Ajv from 'ajv';
import ts from 'typescript';
import { DocumentReadError, type DocumentReadPageV1 } from '../app/lib/documents/contracts';
import { DOCUMENT_READ_ERROR_JSON_SCHEMA_V1, DOCUMENT_READ_PAGE_JSON_SCHEMA_V1 } from '../app/lib/documents/read-json-schema';
import { decodeDirectMcpDocumentReadSelection as decode, DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES } from '../app/lib/mcp/server/document-read-tool-contract';

// Pure selection/schema fixtures only. No token, Principal, SQL result or
// synthetic native Page fixture is used to claim successful authorization.
const version = `canvas-document-v1:${'a'.repeat(64)}`;
const selection = () => ({ workspace_id: 'workspace', document_id: 'document' });
const invalid = (error: unknown) => {
  assert(error instanceof DocumentReadError); assert.equal(error.code, 'INVALID_REQUEST'); return true;
};
const ajv = new Ajv({ strict: true });

async function actualReadDescriptor() {
  const filename = path.resolve('app/lib/mcp/server/workspace-tools.ts');
  const source = await readFile(filename, 'utf8');
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2017, true, ts.ScriptKind.TS);
  const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'getDirectMcpWorkspaceToolDescriptor');
  assert(declaration);
  const compiled = ts.transpileModule(declaration.getText(parsed), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017,
  } }).outputText;
  // Execute the actual descriptor body without importing auth/DB modules. This
  // named security-schema seam is metadata, never an authentication success.
  const definitions: Record<string, unknown> = {};
  const factory = new Function('exports', 'MAX_READ_CHARACTERS', 'DOCUMENT_READ_PAGE_JSON_SCHEMA_V1', 'DOCUMENT_READ_ERROR_JSON_SCHEMA_V1',
    'DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES', 'getToolSecurity', `${compiled}\nreturn exports.getDirectMcpWorkspaceToolDescriptor;`);
  const describe = factory(definitions, 24000, DOCUMENT_READ_PAGE_JSON_SCHEMA_V1, DOCUMENT_READ_ERROR_JSON_SCHEMA_V1, DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES,
    (scope: string) => ({ securitySchemes: [{ type: 'oauth2', scopes: [scope] }],
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] } })) as
      (name: string) => { name: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
        securitySchemes: { scopes: string[] }[] };
  return describe('read_knowledge_source');
}

function pageFixture() {
  return {
    apiVersion: 1,
    document: { kind: 'native_document', workspaceId: 'workspace', organizationId: null, documentId: 'document',
      lineageId: 'lineage', lifecycleGeneration: 1, representation: 'plain_text', schemaVersion: 1,
      path: 'fixture.md', title: 'Fixture title', version, metadataVersion: `canvas-document-metadata-v1:${'b'.repeat(64)}` },
    currency: { source: 'persisted_yjs', observedVersion: version, observedDurable: true,
      durableVersion: version, durableSequence: 7, persistedAt: 100 },
    projection: { checkpointSequence: 0, checkpointedAt: null, status: 'pending' },
    format: 'text', mediaType: 'text/plain', encoding: 'utf-8', fragment: '😀',
    byteOffset: 0, byteLength: 4, totalBytes: 8, nextCursor: 'opaque-comparison-fixture', complete: false,
  } satisfies DocumentReadPageV1;
}

test('legacy selection remains owned by its unchanged path parser', () => {
  const legacy = { workspace_id: 'workspace', path: 'fixture.md', offset: 9, max_characters: 12 };
  assert.equal(decode(legacy), null); assert.deepEqual(legacy, { workspace_id: 'workspace', path: 'fixture.md', offset: 9, max_characters: 12 });
  assert.equal(decode(undefined), null); assert.equal(decode({ workspace_id: 'workspace' }), null);
});

test('native selector returns detached frozen canonical defaults', () => {
  const raw = selection(), captured = decode(raw);
  assert.deepEqual(captured, { apiVersion: 1, workspaceId: 'workspace', documentId: 'document', format: 'native', maxBytes: 65536 });
  assert(Object.isFrozen(captured)); raw.document_id = 'later'; assert.equal(captured?.documentId, 'document');
});

test('all explicit native formats and continuation fields retain exact values', () => {
  for (const format of ['native', 'text', 'markdown']) {
    const captured = decode({ ...selection(), format, expected_version: version, max_bytes: 4, cursor: 'opaque-fixture' });
    assert.deepEqual(captured, { apiVersion: 1, workspaceId: 'workspace', documentId: 'document', format,
      expectedVersion: version, maxBytes: 4, cursor: 'opaque-fixture' });
  }
  assert.equal(decode({ ...selection(), max_bytes: 262144 })?.maxBytes, 262144);
  assert.equal(decode({ workspace_id: 'native-😀', document_id: 'document-🧪' })?.documentId, 'document-🧪');
});

test('any native-only field selects strict native validation without legacy fallback', () => {
  for (const key of ['document_id', 'format', 'expected_version', 'max_bytes', 'cursor']) {
    assert.throws(() => decode({ workspace_id: 'workspace', path: 'fixture.md', [key]: undefined }), invalid);
    assert.throws(() => decode({ ...selection(), [key]: undefined }), invalid);
  }
});

test('mixed path or character paging and unknown native keys are rejected even when undefined', () => {
  for (const key of ['path', 'offset', 'max_characters', 'unknown', 'workspaceId', 'documentId', 'apiVersion', '__proto__']) {
    const raw = { ...selection() };
    Object.defineProperty(raw, key, { value: undefined, enumerable: true });
    assert.throws(() => decode(raw), invalid);
  }
  assert.throws(() => decode({ ...selection(), [Symbol('extra')]: true }), invalid);
});

test('invalid raw ID values are not trimmed coerced or converted through UTF8 replacement', () => {
  for (const key of ['workspace_id', 'document_id']) for (const value of [null, true, 7, '', ' padded ', 'bad\u0000id', '\ud800', {}]) {
    assert.throws(() => decode({ ...selection(), [key]: value }), invalid);
  }
  assert.equal(decode({ ...selection(), workspace_id: 'x'.repeat(256) })?.workspaceId.length, 256);
  assert.equal(decode({ ...selection(), document_id: 'x'.repeat(256) })?.documentId.length, 256);
  assert.throws(() => decode({ ...selection(), workspace_id: 'x'.repeat(257) }), invalid);
  assert.throws(() => decode({ ...selection(), document_id: 'x'.repeat(257) }), invalid);
});

test('native byte range format full-version and cursor syntax stay strict', () => {
  for (const max_bytes of [null, '4', 0, 3, -1, -0, 4.1, 262145, NaN, Infinity]) assert.throws(() => decode({ ...selection(), max_bytes }), invalid);
  for (const format of [null, '', 'blocks', 'TEXT', 7]) assert.throws(() => decode({ ...selection(), format }), invalid);
  for (const expected_version of [null, 'a'.repeat(64), version.toUpperCase(), `${version}x`]) assert.throws(() => decode({ ...selection(), expected_version }), invalid);
  for (const cursor of [null, '', ' padded ', 'bad\nvalue', 'x'.repeat(4097), 7]) assert.throws(() => decode({ ...selection(), cursor }), invalid);
});

test('native descriptors are getter-free and exact enumerable data properties', () => {
  let reads = 0;
  for (const key of ['workspace_id', 'document_id', 'format', 'expected_version', 'max_bytes', 'cursor']) {
    const raw = { ...selection() };
    Object.defineProperty(raw, key, { enumerable: true, get: () => { reads++; return 'untrusted'; } });
    assert.throws(() => decode(raw), invalid);
  }
  const hidden = selection(); Object.defineProperty(hidden, 'document_id', { value: 'document', enumerable: false });
  assert.throws(() => decode(hidden), invalid); assert.equal(reads, 0);
});

test('native exotic prototypes and live or revoked Proxies are refused without traps', () => {
  assert.throws(() => decode(Object.assign(Object.create(null), selection())), invalid);
  assert.throws(() => decode(Object.assign(Object.create({}), selection())), invalid);
  assert.throws(() => decode(Object.assign([], selection())), invalid);
  let traps = 0;
  const proxy = new Proxy(selection(), { getPrototypeOf: () => { traps++; return Object.prototype; },
    getOwnPropertyDescriptor: () => { traps++; return undefined; }, ownKeys: () => { traps++; return []; }, get: () => { traps++; return undefined; } });
  assert.throws(() => decode(proxy), invalid);
  const revoked = Proxy.revocable(selection(), {}); revoked.revoke(); assert.throws(() => decode(revoked.proxy), invalid);
  assert.equal(traps, 0);
});

test('actual descriptor keeps existing tool/scope and requires exactly one unmixed selector', async () => {
  const descriptor = await actualReadDescriptor();
  assert.equal(descriptor.name, 'read_knowledge_source'); assert.deepEqual(descriptor.securitySchemes[0].scopes, ['knowledge:read']);
  assert.deepEqual(descriptor.inputSchema.required, ['workspace_id']); assert.equal(descriptor.inputSchema.additionalProperties, false);
  assert(Array.isArray(descriptor.inputSchema.oneOf)); assert.equal(descriptor.inputSchema.oneOf.length, 2);
  const properties = descriptor.inputSchema.properties as Record<string, unknown>;
  for (const key of ['workspace_id', 'path', 'offset', 'max_characters', 'document_id', 'format', 'expected_version', 'max_bytes', 'cursor']) assert(Object.hasOwn(properties, key));
  const validate = ajv.compile(descriptor.inputSchema);
  assert(validate({ workspace_id: 'workspace', path: 'fixture.md', offset: 2, max_characters: 20 }));
  assert(validate({ ...selection(), format: 'text', max_bytes: 4, expected_version: version }));
  assert(validate({ ...selection(), workspace_id: 'x'.repeat(256) }));
  assert.equal(validate({ ...selection(), workspace_id: 'x'.repeat(257) }), false);
  assert.equal(validate({ workspace_id: 'workspace' }), false);
  assert.equal(validate({ workspace_id: 'workspace', offset: 0 }), false);
  const nativeValues: Record<string, unknown> = { document_id: 'document', format: 'native', expected_version: version, max_bytes: 4, cursor: 'fixture' };
  for (const key of ['document_id', 'format', 'expected_version', 'max_bytes', 'cursor']) {
    assert.equal(validate({ workspace_id: 'workspace', path: 'fixture.md', [key]: nativeValues[key] }), false);
  }
  for (const key of ['path', 'offset', 'max_characters']) {
    assert.equal(validate({ ...selection(), [key]: key === 'path' ? 'fixture.md' : 1 }), false);
  }
  assert.equal(validate({ ...selection(), unknown: true }), false);
});

test('actual output schema accepts every existing legacy output field and only its complete variant', async () => {
  const descriptor = await actualReadDescriptor(); const validate = ajv.compile(descriptor.outputSchema);
  const legacy = { workspace_id: 'workspace', path: 'fixture.md', content: 'ABC', sha256: 'c'.repeat(64), source: 'file',
    truncated: false, next_offset: null, size: 3, modified_at: null };
  assert(validate(legacy), JSON.stringify(validate.errors));
  for (const key of Object.keys(legacy)) { const missing = { ...legacy } as Record<string, unknown>; delete missing[key]; assert.equal(validate(missing), false); }
  assert.equal(validate({ ...legacy, nativeVersion: version }), false);
});

test('central Page schema and actual output variant require the full native DTO and preserve JSON cursor/fragment', async () => {
  const descriptor = await actualReadDescriptor(), validate = ajv.compile(descriptor.outputSchema);
  const fixture = pageFixture(); assert(validate(fixture), JSON.stringify(validate.errors));
  const native = ajv.compile(DOCUMENT_READ_PAGE_JSON_SCHEMA_V1); assert(native(fixture), JSON.stringify(native.errors));
  assert.deepEqual(JSON.parse(JSON.stringify(fixture)), fixture); assert.equal(Object.hasOwn(fixture, 'sha256'), false);
  for (const key of Object.keys(fixture)) { const missing = { ...fixture } as Record<string, unknown>; delete missing[key]; assert.equal(validate(missing), false); }
  assert.equal(validate({ ...fixture, sha256: 'c'.repeat(64) }), false);
  assert.equal(validate({ ...fixture, document: { ...fixture.document, token: 'must-not-exist' } }), false);
});

test('actual output schema includes only the closed bounded native error DTO', async () => {
  const descriptor = await actualReadDescriptor(), validate = ajv.compile(descriptor.outputSchema);
  const nativeError = ajv.compile(DOCUMENT_READ_ERROR_JSON_SCHEMA_V1);
  for (const code of DOCUMENT_READ_ERROR_JSON_SCHEMA_V1.properties.code.enum) {
    const failure = { apiVersion: 1, success: false, code };
    assert(nativeError(failure), JSON.stringify(nativeError.errors)); assert(validate(failure), JSON.stringify(validate.errors));
    assert.deepEqual(JSON.parse(JSON.stringify(failure)), failure);
  }
  const failure = { apiVersion: 1, success: false, code: 'ACCESS_DENIED' };
  for (const key of ['sql', 'token', 'origin', 'message', 'status']) assert.equal(validate({ ...failure, [key]: 'private' }), false);
  assert.equal(validate({ ...failure, code: 'PRIVATE_ORIGIN_FAILURE' }), false);
  assert.equal(validate({ ...failure, success: true }), false);
  assert.equal(validate({ apiVersion: 1, success: false }), false);
});

test('central schemas are deeply frozen and include native identities currency projection and paging', () => {
  const visit = (value: unknown) => {
    if (value && typeof value === 'object') { assert(Object.isFrozen(value)); for (const child of Object.values(value)) visit(child); }
  };
  visit(DOCUMENT_READ_PAGE_JSON_SCHEMA_V1); visit(DOCUMENT_READ_ERROR_JSON_SCHEMA_V1); visit(DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES);
  const required = DOCUMENT_READ_PAGE_JSON_SCHEMA_V1.required;
  for (const key of ['document', 'currency', 'projection', 'fragment', 'byteOffset', 'byteLength', 'totalBytes', 'nextCursor', 'complete']) assert(required.includes(key));
});
