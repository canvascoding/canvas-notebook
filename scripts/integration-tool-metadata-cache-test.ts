import assert from 'node:assert/strict';
import { createIntegrationMetadataCacheKey, IntegrationMetadataCache } from '../app/lib/integration-tools/metadata-cache';
import type { IntegrationExecutionContext } from '../app/lib/integration-tools/contracts';

const context: IntegrationExecutionContext = { actorUserId: 'alice', organizationId: 'org-a', workspaceId: 'team-a', agentId: 'designer', policyRevision: 'policy-1' };
const keyInput = { context, source: 'mcp' as const, providerRef: 'mcp:v1:fixture', revision: 'credential-a', kind: 'tool_catalog' as const };
const originalKey = createIntegrationMetadataCacheKey(keyInput);
for (const changed of [
  { ...keyInput, source: 'composio' as const },
  { ...keyInput, providerRef: 'mcp:v1:other' },
  { ...keyInput, revision: 'credential-b' },
  { ...keyInput, selector: { cursor: 'page-2' } },
  ...['actorUserId', 'organizationId', 'workspaceId', 'agentId', 'policyRevision'].map((field) => ({
    ...keyInput, context: { ...context, [field]: 'different' },
  })),
]) assert.notEqual(createIntegrationMetadataCacheKey(changed), originalKey);
assert.throws(() => createIntegrationMetadataCacheKey({ ...keyInput, revision: ' ' }));

let now = 100;
const cache = new IntegrationMetadataCache({ maxEntries: 2, maxBytes: 100, maxEntryBytes: 70, ttlMs: 10, now: () => now });
const metadata = [{ name: 'create_design', description: 'Design' }];
assert.equal(cache.set(originalKey, metadata, { complete: true }), true);
metadata[0].name = 'changed';
const read = cache.get<typeof metadata>(originalKey)!;
assert.equal(read[0].name, 'create_design');
read[0].description = 'Mutated';
assert.equal(cache.get<typeof metadata>(originalKey)?.[0].description, 'Design');
assert.equal(cache.set('partial', metadata, { complete: false }), false);
assert.equal(cache.get('partial'), undefined);
assert.equal(cache.set('aborted', metadata, { complete: true, signal: AbortSignal.abort() }), false);
assert.equal(cache.set('huge', { value: 'x'.repeat(71) }, { complete: true }), false);
assert.equal(cache.set('one', 'one', { complete: true }), true);
cache.get(originalKey);
assert.equal(cache.set('two', 'two', { complete: true }), true);
assert.equal(cache.get('one'), undefined, 'entry cap evicts the least recently used metadata');
assert.equal(cache.size, 2);
assert.equal(cache.set('larger', 'x'.repeat(65), { complete: true }), true);
assert.ok(cache.bytes <= 100);
assert.equal(cache.get(originalKey), undefined, 'byte budget evicts metadata before accepting a new entry');
now += 10;
assert.equal(cache.get('larger'), undefined);
assert.equal(cache.set('new', 'new', { complete: true }), true);
assert.equal(cache.size, 1, 'writes remove expired entries');
cache.clear();
assert.equal(cache.size, 0);
assert.equal(cache.bytes, 0);
for (const limits of [{ maxEntries: 0 }, { ttlMs: -1 }, { maxBytes: 1.5 }, { maxEntryBytes: Infinity }]) {
  assert.throws(() => new IntegrationMetadataCache(limits));
}
console.log('PASS metadata cache: source/context/credential separation, immutable values, incomplete/aborted exclusion, TTL, entry and byte bounds.');
