#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

const expectedPayload = {
  x86_64: {
    avcodec: 'd0f0b65dd8d194278309dce64a9661040f0f7bd77d0d20733a0d7a06bdb26a5b',
    x264: '5587d2d060914e2e52694e35703a7c8f20f3143eafa956706e089049df3b580b',
    x265: 'e304e1b3b6367e902837b9a00d0bc5b90d83a70e1fbb69b27f34d8c970c4b765',
    ctranslate2: 'ebebd2799bf0c8a4c89044b986e94512ed5c80cd7ef1c95dc67872a4384df9f7',
    extension: '950226013cf76324e5d51392baa94cf517e3c994163fc50780631328caec7c74',
    gomp: 'a43904e4fa297301d4640dc1bb3c8a3480b406f99e498eba9b1914b68aab604a',
  },
  aarch64: {
    avcodec: 'f841da47019114ae55b6483eac6fa3e2b927b8757851bc2fcd8aafbe33d2bfd4',
    x264: '0199ff501948aa1d5a723a44cd79dedd3a88fc5c45deb3ea31056cc6baccbd5c',
    x265: '989f4619d543cc33a64557141585283a91aaa45b3b656c41792054fae5284a89',
    ctranslate2: '40e95ee2b44ef40056263a2204ac1179e52f0f8dbd365c4b55f527709f136a9d',
    extension: '8b1a8ca29a6be7ccc9146e1db32eb0fbf04baac856263966b8e5a2a8d1124b16',
    gomp: '43642df04bdf20f9b4122d336ef3e2e6a486c536e614159ac0e981a901d54537',
  },
};

function verify(evidence) {
  assert.equal(evidence.schemaVersion, 1);
  assert(Object.hasOwn(expectedPayload, evidence.architecture));
  assert.equal(evidence.av.version, '18.1.0');
  assert.equal(evidence.ctranslate2.version, '4.8.2');
  for (const entry of [
    evidence.av.avcodec,
    evidence.av.x264,
    evidence.av.x265,
    evidence.ctranslate2.library,
    evidence.ctranslate2.bundledGomp,
    evidence.ctranslate2.extension,
  ]) {
    assert.match(entry.file, /\.so(?:[.\w-]*)?$/u);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u);
  }
  const expected = expectedPayload[evidence.architecture];
  assert.equal(evidence.av.avcodec.sha256, expected.avcodec);
  assert.equal(evidence.av.x264.sha256, expected.x264);
  assert.equal(evidence.av.x265.sha256, expected.x265);
  assert.equal(evidence.ctranslate2.library.sha256, expected.ctranslate2);
  assert.equal(evidence.ctranslate2.extension.sha256, expected.extension);
  assert.equal(evidence.ctranslate2.bundledGomp.sha256, expected.gomp);
  assert.deepEqual(
    evidence.av.wheelLicenseFiles.map((entry) => entry.file.split('/').at(-1)).sort(),
    ['AUTHORS.py', 'AUTHORS.rst', 'LICENSE.txt'],
  );
  assert.equal(
    evidence.av.wheelLicenseFiles.find((entry) => entry.file.endsWith('/LICENSE.txt'))?.sha256,
    '76af0461ffb92e19f1c14449e95557d83a2dfaa1baf202d49e5f1d8746c0da19',
  );
  assert.deepEqual(evidence.ctranslate2.wheelLicenseFiles, []);
  assert.equal(evidence.av.avcodecLinksBundledX264, true);
  assert.equal(evidence.av.avcodecLinksBundledX265, true);
  assert.equal(evidence.ctranslate2.extensionLinksBundledLibrary, true);
  assert.equal(evidence.ctranslate2.extensionLinksBundledGomp, true);
  assert.match(evidence.av.avcodecLicense, /LGPL version 3 or later/iu);
  for (const flag of ['--enable-libx264', '--enable-libx265', '--enable-version3']) {
    assert(evidence.av.avcodecConfiguration.includes(flag), `PyAV FFmpeg lacks ${flag}`);
  }
  assert(!evidence.av.avcodecConfiguration.includes('--enable-gpl'), 'PyAV FFmpeg license mode changed');
  for (const flag of ['--enable-gpl', '--enable-libx264', '--enable-libx265']) {
    assert(evidence.ffmpegCli.configuration.includes(flag), `CLI FFmpeg lacks ${flag}`);
  }
}

const paths = process.argv.slice(2);
assert(paths.length === 1 || paths.length === 2,
  'usage: dictation-native-evidence-test.mjs <amd64-or-arm64 evidence> [other architecture evidence]');
const evidence = paths.map((path) => JSON.parse(fs.readFileSync(path, 'utf8')));
for (const entry of evidence) verify(entry);
if (evidence.length === 2) {
  assert.deepEqual(evidence.map((entry) => entry.architecture).sort(), ['aarch64', 'x86_64']);
}
console.log(`dictation-native-evidence-test: ok (${evidence.map((entry) => entry.architecture).join(', ')})`);
