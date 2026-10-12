import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  cloneIntegrationArguments,
  createIntegrationSchemaRef,
  INTEGRATION_SCHEMA_LIMITS,
  schemaFingerprint,
  validateIntegrationArguments,
  validateIntegrationSchema,
} from '../app/lib/integration-tools/schema';
import { IntegrationContractError } from '../app/lib/integration-tools/contracts';
import { UNRESTRICTED_INTEGRATION_POLICY } from '../app/lib/integration-tools/policy';

async function invalidArguments(schema: unknown, args: unknown) {
  await assert.rejects(validateIntegrationArguments(schema, args),
    (error) => error instanceof IntegrationContractError && error.code === 'invalid_arguments');
}

async function unsupported(schema: unknown) {
  await assert.rejects(validateIntegrationSchema(schema),
    (error) => error instanceof IntegrationContractError && error.code === 'schema_unsupported');
}

async function testDraftsAndLocalReferences() {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object', required: ['design'], additionalProperties: false,
    properties: { design: { $ref: '#/definitions/design' } },
    definitions: { design: {
      type: 'object', required: ['name', 'pages'], additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 2 },
        pages: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
        child: { $ref: '#/definitions/design' },
      },
    } },
  };
  await validateIntegrationSchema(schema);
  await validateIntegrationArguments(schema, { design: { name: 'Design', pages: [1, 2], child: { name: 'Child', pages: [3] } } });
  await invalidArguments(schema, { design: { name: 'Design', pages: [1, '2'] } });
  await invalidArguments(schema, { design: { name: 'X', pages: [1] } });
  await invalidArguments(schema, { design: { name: 'Design' } });
  await invalidArguments(schema, { design: { name: 'Design', pages: [1, 1] } });
  await invalidArguments(schema, { design: { name: 'Design', pages: [1], extra: true } });
  await invalidArguments(schema, { design: { name: 'Design', pages: [1] }, outerExtra: true });

  const schema2019 = {
    $schema: 'https://json-schema.org/draft/2019-09/schema',
    type: 'object', properties: { customer: { type: 'string' }, credit: { type: 'integer' },
      labels: { type: 'array', contains: { type: 'string' }, minContains: 2, maxContains: 3 } },
    dependentRequired: { credit: ['customer'] }, unevaluatedProperties: false,
  };
  await validateIntegrationArguments(schema2019, { customer: 'fixture', credit: 1, labels: ['a', 'b', 3] });
  await invalidArguments(schema2019, { credit: 1 });
  await invalidArguments(schema2019, { labels: ['a', 1] });
  await invalidArguments(schema2019, { unknown: true });
  const recursive2019 = { $schema: 'https://json-schema.org/draft/2019-09/schema', $recursiveAnchor: true,
    type: 'object', properties: { child: { $recursiveRef: '#' }, value: { type: 'integer' } }, additionalProperties: false };
  await validateIntegrationArguments(recursive2019, { value: 1, child: { value: 2 } });
  await invalidArguments(recursive2019, { child: { value: '2' } });

  const schema2020 = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', required: ['pair'], properties: { pair: { $ref: '#/$defs/pair' } },
    $defs: { pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false, minItems: 2 } },
    unevaluatedProperties: false,
  };
  await validateIntegrationArguments(schema2020, { pair: ['a', 2] });
  await invalidArguments(schema2020, { pair: [2, 'a'] });
  await invalidArguments(schema2020, { pair: ['a', 2, 3] });
  const dynamic2020 = { $schema: 'https://json-schema.org/draft/2020-12/schema', $dynamicAnchor: 'tree',
    type: 'object', properties: { child: { $dynamicRef: '#tree' }, value: { type: 'integer' } }, additionalProperties: false };
  await validateIntegrationArguments(dynamic2020, { value: 1, child: { value: 2 } });
  await invalidArguments(dynamic2020, { child: { value: '2' } });
  await validateIntegrationArguments({ $defs: { text: { type: 'string' } }, $ref: '#/$defs/text' }, 'text');
  await validateIntegrationArguments(true, { any: 'JSON' });
  await invalidArguments(false, {});
}

async function testCombinatorsFormatsAndNoMutation() {
  const combinators = {
    type: 'object', required: ['kind', 'amount'],
    properties: { kind: { enum: ['small', 'large'] }, amount: { type: 'integer' }, marker: { type: ['string', 'null'] } },
    allOf: [{ not: { required: ['forbidden'] } }],
    if: { properties: { kind: { const: 'large' } }, required: ['kind'] },
    then: { properties: { amount: { minimum: 10 } } }, else: { properties: { amount: { maximum: 9 } } },
    oneOf: [{ properties: { amount: { multipleOf: 2 } } }, { properties: { amount: { multipleOf: 3 } } }],
    anyOf: [{ required: ['marker'] }, { properties: { amount: { minimum: 4 } } }],
  };
  await validateIntegrationArguments(combinators, { kind: 'small', amount: 4 });
  await invalidArguments(combinators, { kind: 'small', amount: 6 });
  await invalidArguments(combinators, { kind: 'large', amount: 4 });
  await invalidArguments(combinators, { kind: 'small', amount: 4, forbidden: true });
  const formats = { type: 'object', required: ['email', 'timestamp', 'id'], additionalProperties: false,
    properties: { email: { type: 'string', format: 'email' }, timestamp: { type: 'string', format: 'date-time' },
      id: { type: 'string', format: 'uuid' } } };
  const valid = { email: 'fixture@example.test', timestamp: '2026-10-06T12:00:00Z', id: 'b4f75c49-26d0-4c72-8c10-d79d97c0c1a8' };
  await validateIntegrationArguments(formats, valid);
  await invalidArguments(formats, { ...valid, email: 'invalid' });
  await invalidArguments(formats, { ...valid, timestamp: '2026-02-30T12:00:00Z' });
  await invalidArguments(formats, { ...valid, id: 'not-a-uuid' });
  const noMutation = Object.freeze({ type: 'object', additionalProperties: false,
    properties: Object.freeze({ amount: Object.freeze({ type: 'integer', default: 5 }) }) });
  const absent = Object.freeze({});
  await validateIntegrationArguments(noMutation, absent);
  assert.deepEqual(absent, {}, 'Default values are never applied.');
  const wrongType = Object.freeze({ amount: '5' });
  await invalidArguments(noMutation, wrongType);
  assert.deepEqual(wrongType, { amount: '5' }, 'Argument types are never coerced.');
  const extra = Object.freeze({ amount: 5, extra: true });
  await invalidArguments(noMutation, extra);
  assert.deepEqual(extra, { amount: 5, extra: true }, 'Additional arguments are rejected, not removed.');
  const literalRef = { type: 'object', const: { $ref: 'https://example.test/literal-data' } };
  await validateIntegrationArguments(literalRef, { $ref: 'https://example.test/literal-data' });
}

async function testUnsupportedAndResourceBounds() {
  await unsupported({ $schema: 'https://example.test/custom-schema', type: 'object' });
  await unsupported({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' });
  await unsupported({ type: 'number', typoMaximum: 1 });
  await unsupported({ $schema: 'https://json-schema.org/draft/2020-12/schema',
    $vocabulary: { 'https://example.test/required-validation': true }, type: 'object' });
  await validateIntegrationArguments({ $schema: 'https://json-schema.org/draft/2020-12/schema',
    $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/validation': true }, type: 'object' }, {});
  await unsupported({ type: 'string', format: 'unknown-provider-format' });
  await unsupported({ $async: true, type: 'object' });
  await unsupported({ $ref: '#/missing' });
  await unsupported({ type: 'string', pattern: '[' });
  await unsupported({ $schema: 'http://json-schema.org/draft-07/schema#', unevaluatedProperties: false });
  let remoteCalls = 0;
  const server = http.createServer((_request, response) => { remoteCalls += 1; response.end('{}'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    await unsupported({ type: 'object', properties: { remote: { $ref: `http://127.0.0.1:${address.port}/schema` } } });
    assert.equal(remoteCalls, 0, 'Remote references never trigger a network request.');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  const cyclic: Record<string, unknown> = {}; cyclic.child = cyclic;
  await unsupported(cyclic);
  await invalidArguments(true, cyclic);
  await invalidArguments(true, { bad: undefined });
  await invalidArguments(true, { bad: NaN });
  await invalidArguments(true, new Date());
  await unsupported({ type: 'string', description: 'x'.repeat(INTEGRATION_SCHEMA_LIMITS.schemaBytes + 1) });
  await invalidArguments(true, { text: 'x'.repeat(INTEGRATION_SCHEMA_LIMITS.argumentBytes + 1) });
  let deep: Record<string, unknown> = {};
  for (let depth = 0; depth <= INTEGRATION_SCHEMA_LIMITS.depth; depth += 1) deep = { child: deep };
  await invalidArguments(true, deep);
  await unsupported(deep);
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get: () => { getterCalls += 1; return 'value'; } });
  await invalidArguments(true, getter);
  assert.equal(getterCalls, 0);
  let eventLoopResponsive = false;
  const tick = setTimeout(() => { eventLoopResponsive = true; }, 50);
  const started = Date.now();
  await assert.rejects(validateIntegrationArguments({ type: 'string', pattern: '^(a+)+$' }, `${'a'.repeat(80)}!`),
    (error) => error instanceof IntegrationContractError && error.code === 'schema_unsupported' && /processing limit/u.test(error.message));
  clearTimeout(tick);
  assert.equal(eventLoopResponsive, true, 'Expensive regex validation does not block the server event loop.');
  assert.ok(Date.now() - started < INTEGRATION_SCHEMA_LIMITS.workerTimeoutMs + 3000, 'A pathological regex is terminated within a bounded interval.');
  await validateIntegrationArguments({ type: 'integer' }, 2);
}

function testSchemaReferences() {
  const base = { context: { actorUserId: 'alice', organizationId: 'org-a', workspaceId: 'team-a', agentId: 'designer', policyRevision: 'policy-1' },
    policy: UNRESTRICTED_INTEGRATION_POLICY, providerRef: 'opaque-bound-profile-a', bindingRevision: 'account-a:revision-1',
    toolName: 'CANVA_LIST_DESIGNS', toolVersion: '20261006_00', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } };
  const ref = createIntegrationSchemaRef(base);
  assert.equal(createIntegrationSchemaRef({ ...base, inputSchema: { properties: { limit: { type: 'integer' } }, type: 'object' } }), ref);
  assert.doesNotMatch(ref, /alice|profile|account|CANVA/u);
  for (const changed of [
    { ...base, providerRef: 'opaque-bound-profile-b' }, { ...base, bindingRevision: 'account-b:revision-1' },
    { ...base, toolName: 'CANVA_CREATE_DESIGN' }, { ...base, toolVersion: '20261007_00' },
    { ...base, inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { ...base, outputSchema: { type: 'array' } },
    { ...base, policy: { ...base.policy, allowedToolNames: [] } },
    { ...base, context: { ...base.context, actorUserId: 'bob' } },
    { ...base, context: { ...base.context, workspaceId: 'team-b' } },
    { ...base, context: { ...base.context, policyRevision: 'policy-2' } },
  ]) assert.notEqual(createIntegrationSchemaRef(changed), ref);
  assert.equal(schemaFingerprint({ a: 1, b: [2, 3] }), schemaFingerprint({ b: [2, 3], a: 1 }));
  assert.notEqual(schemaFingerprint([1, 2]), schemaFingerprint([2, 1]));
}

async function main() {
  testSchemaReferences();
  await testDraftsAndLocalReferences();
  await testCombinatorsFormatsAndNoMutation();
  await testUnsupportedAndResourceBounds();
  console.log('PASS integration schemas: full draft07/2019/2020 validation, local recursion, formats, immutable arguments, strict unknown schemas, opaque context bindings and bounded worker execution.');
}

const originalArguments = { nested: { amount: 1 } };
const capturedArguments = cloneIntegrationArguments(originalArguments);
originalArguments.nested.amount = 2;
assert.deepEqual(capturedArguments, { nested: { amount: 1 } });
for (const malformed of [[], { value: () => 1 }, { value: NaN }, { text: 'x'.repeat(INTEGRATION_SCHEMA_LIMITS.argumentBytes + 1) }]) {
  assert.throws(() => cloneIntegrationArguments(malformed), { code: 'invalid_arguments' });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
