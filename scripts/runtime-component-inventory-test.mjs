#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

const inventoryPath = process.argv[2] || '/app/docs/compliance/runtime-components.json';
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));

assert.equal(inventory.schemaVersion, 3);
assert.match(
  inventory.baseImage,
  /^node:24-bookworm-slim@sha256:[a-f0-9]{64}$/u,
  'Docker runtime inventory must identify an immutable multi-architecture base-image digest',
);
assert.match(inventory.platform, /^(?:linux\/)?(?:amd64|arm64|ppc64le)(?:\/v8)?$/u);
assert.equal(inventory.nativeComponents.length, 1);
assert.equal(inventory.nativeComponents[0].name, 'node');
assert.match(inventory.nativeComponents[0].version, /^24\./u);
assert(
  inventory.nativeComponents[0].noticeFiles.some((entry) => (
    entry.path === '/usr/local/LICENSE' && /^[a-f0-9]{64}$/u.test(entry.sha256 || '')
  )),
  'the Node runtime must retain its aggregated upstream LICENSE file',
);
assert(inventory.dpkgPackages.length > 0, 'Docker runtime inventory must contain Debian packages');
assert(inventory.pythonPackages.length > 0, 'Docker runtime inventory must contain Python packages');
assert(inventory.globalNpmPackages.length > 0, 'Docker runtime inventory must contain global npm packages');

for (const component of inventory.dpkgPackages) {
  assert(component.name);
  assert(component.version);
  assert(component.sourcePackage);
  assert(component.sourceVersion);
  assert.match(component.noticePath, /^\/usr\/share\/doc\/.+\/copyright$/u);
  assert.match(
    component.noticeSha256 || '',
    /^[a-f0-9]{64}$/u,
    `${component.name}@${component.version} must retain a readable Debian copyright file`,
  );
}

for (const component of inventory.pythonPackages) {
  assert(component.name);
  assert(component.version);
  assert(['deb', 'pip'].includes(component.managedBy));
  for (const licenseFile of component.licenseFiles) {
    assert(licenseFile.path);
    assert.match(
      licenseFile.sha256 || '',
      /^[a-f0-9]{64}$/u,
      `${component.name}@${component.version} has an unreadable Python license file`,
    );
  }
  assert(
    component.licenseExpression
      || component.license
      || component.licenseFiles.length > 0
      || (
        component.managedBy === 'deb'
        && component.debianPackage
        && inventory.dpkgPackages.some((candidate) => candidate.name === component.debianPackage)
      ),
    `${component.name}@${component.version} needs license metadata or a packaged license file`,
  );
}

for (const component of inventory.globalNpmPackages) {
  assert(component.name);
  assert(component.version);
  assert(component.packagePath.startsWith('/usr/local/lib/node_modules/'));
  assert(
    component.declaredLicense || component.noticeFiles.length > 0,
    `${component.name}@${component.version} needs a declared license or packaged notice`,
  );
  for (const noticeFile of component.noticeFiles) {
    assert.match(noticeFile.sha256 || '', /^[a-f0-9]{64}$/u);
  }
}

console.log(
  `runtime-component-inventory-test: ok (${inventory.dpkgPackages.length} Debian, `
  + `${inventory.pythonPackages.length} Python, `
  + `${inventory.globalNpmPackages.length} global npm packages)`,
);
