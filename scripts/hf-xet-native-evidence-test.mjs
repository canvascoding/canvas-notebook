#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

const expected = {
  amd64: {
    machine: 'X86-64',
    sha256: '9f493e4d60ce7d973f77d6e638efc9fa59329967de8b17d2fb83baf3ed8d73b9',
    size: 12210648,
    needed: ['libgcc_s.so.1', 'librt.so.1', 'libpthread.so.0', 'libm.so.6', 'libdl.so.2', 'libc.so.6', 'ld-linux-x86-64.so.2'],
  },
  arm64: {
    machine: 'AArch64',
    sha256: 'bcc6a3cbf4e36c16df2c40c5b124852be2acb293fc4130e11224029a04adc383',
    size: 11385256,
    needed: ['libgcc_s.so.1', 'libpthread.so.0', 'libm.so.6', 'libdl.so.2', 'libc.so.6'],
  },
};

const paths = process.argv.slice(2);
assert(paths.length === 1 || paths.length === 2,
  'usage: hf-xet-native-evidence-test.mjs <one architecture evidence> [other architecture evidence]');
const images = paths.flatMap((path) => {
  const evidence = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.equal(evidence.schemaVersion, 1);
  assert(Array.isArray(evidence.images));
  assert(paths.length === 1 ? [1, 2].includes(evidence.images.length) : evidence.images.length === 1);
  return evidence.images;
});
assert(images.length === 1 || images.length === 2);
assert.equal(new Set(images.map((entry) => entry.architecture)).size, images.length);
for (const entry of images) {
  assert(Object.hasOwn(expected, entry.architecture));
  const pinned = expected[entry.architecture];
  assert.equal(entry.distribution, 'hf-xet@1.6.0');
  assert.equal(entry.file, 'hf_xet/hf_xet.abi3.so');
  assert.equal(entry.recordMatches, true);
  assert.equal(entry.sha256, pinned.sha256);
  assert.equal(entry.size, pinned.size);
  assert(entry.elfMachine.includes(pinned.machine));
  assert.deepEqual(entry.needed, pinned.needed);
  assert.match(entry.imageId, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(typeof entry.image, 'string');
  assert(entry.image.length > 0);
}
if (paths.length === 2) {
  assert.deepEqual(images.map((entry) => entry.architecture).sort(), ['amd64', 'arm64']);
}
console.log(`hf-xet-native-evidence-test: ok (${images.map((entry) => entry.architecture).join(', ')})`);
