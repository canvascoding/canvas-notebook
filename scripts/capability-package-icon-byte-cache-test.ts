import assert from 'node:assert/strict';
import { createPackageIconByteCache } from '../app/lib/capabilities/packages/package-icon-byte-cache';

let clock = 0, validations = 0;
const cache = createPackageIconByteCache({ maxBytes: 6, maxEntries: 2, ttlMs: 20, now: () => clock });
const read = (source = 'source-a', type = 'image/svg+xml', text = 'one', valid = true) => cache(source, type, Buffer.from(text), () => { validations++; return valid; });
assert.equal(read()!.toString(), 'one'); assert.equal(validations, 1);
const returned = read()!; returned.fill(0);
assert.equal(read()!.toString(), 'one'); assert.equal(validations, 1, 'Callers cannot mutate cached bytes.');
read('source-b'); assert.equal(validations, 2, 'Source changes do not reuse the previous validation.');
read(); read('source-c'); assert.equal(validations, 3);
read('source-b'); assert.equal(validations, 4, 'The least recently used entry is evicted at the byte/entry budget.');
clock = 21; read('source-b'); assert.equal(validations, 5, 'Expired entries require validation again.');
assert.equal(read('source-b', 'image/png', 'one', false), null);
assert.equal(read('source-b', 'image/png', 'one', false), null); assert.equal(validations, 7, 'Invalid images are never retained and MIME is part of identity.');
assert.equal(read('source-b', 'image/svg+xml', 'bad', false), null); assert.equal(validations, 8, 'Actual changed bytes cannot hit an existing checksum claim.');
read('large', 'image/svg+xml', 'toolarge'); read('large', 'image/svg+xml', 'toolarge'); assert.equal(validations, 10, 'Oversized entries do not enter the cache.');
console.log('PASS bounded exact-source image bytes: actual byte/MIME identity, LRU, TTL, caller mutation isolation and invalid/oversized exclusion. Fresh authorization remains outside this byte-only cache.');
