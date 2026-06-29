import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8');

const polyfillIndex = serverSource.indexOf("globalThis.AsyncLocalStorage = AsyncLocalStorage");
const nextImportIndex = serverSource.indexOf("const next = require('next')");

assert.notEqual(polyfillIndex, -1, 'server.js must polyfill globalThis.AsyncLocalStorage');
assert.notEqual(nextImportIndex, -1, 'server.js must import next');
assert.ok(
  polyfillIndex < nextImportIndex,
  'server.js must polyfill globalThis.AsyncLocalStorage before importing next',
);

console.log('next-startup-runtime-test: ok');
