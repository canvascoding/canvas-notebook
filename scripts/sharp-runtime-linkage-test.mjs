#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const appRoot = process.env.CANVAS_APP_ROOT || '/app';
const outputPath = process.argv[2] || null;
const inventoryPath = path.join(appRoot, 'docs/compliance/runtime-components.json');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ldd(filePath) {
  return execFileSync('ldd', [filePath], { encoding: 'utf8' });
}

const directRequire = createRequire(path.join(appRoot, 'package.json'));
const nextRequire = createRequire(path.join(appRoot, 'node_modules/next/package.json'));
const sharpModules = [
  { packagePath: 'node_modules/sharp', sharp: directRequire('sharp') },
  { packagePath: 'node_modules/next/node_modules/sharp', sharp: nextRequire('sharp') },
];

const evidence = [];
for (const component of inventory.sharpBuilds) {
  assert(fs.existsSync(component.addonPath), `${component.addonPath} must exist`);
  const linkage = ldd(component.addonPath);
  assert.match(
    linkage,
    /libvips-cpp\.so[^\n]*=> \/usr\/local\/lib\//u,
    `${component.addonPath} must dynamically resolve the replaceable Canvas libvips`,
  );
  assert.doesNotMatch(
    linkage,
    /@img\/sharp-libvips/u,
    `${component.addonPath} must not resolve an @img/sharp-libvips aggregate`,
  );
  evidence.push({
    packagePath: component.packagePath,
    version: component.version,
    addonPath: component.addonPath,
    addonSha256: component.addonSha256,
    ldd: linkage.trim().split(/\r?\n/u),
  });
}

for (const { packagePath, sharp } of sharpModules) {
  const png = await sharp(Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#0a7"/></svg>',
  )).png().toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png', `${packagePath} must perform a real conversion`);
  assert.equal(metadata.width, 4);
  assert.equal(metadata.height, 3);
}

const libvips = inventory.nativeComponents.find((component) => component.name === 'libvips');
assert(libvips);
const result = {
  schemaVersion: 1,
  platform: inventory.platform,
  libvips: {
    version: libvips.version,
    linkage: libvips.linkage,
    sourceUrl: libvips.sourceUrl,
    sourceArchiveSha256: libvips.sourceArchiveSha256,
  },
  sharpBuilds: evidence,
  conversionFixtureSha256: sha256('4x3:#0a7:png'),
};

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

console.log(
  `sharp-runtime-linkage-test: ok (${inventory.platform}, libvips ${libvips.version}, ${evidence.length} sharp builds)`,
);
