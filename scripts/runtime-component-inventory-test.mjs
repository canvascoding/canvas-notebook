#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

const inventoryPath = process.argv[2] || '/app/docs/compliance/runtime-components.json';
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));

assert.equal(inventory.schemaVersion, 2);
assert.match(
  inventory.baseImage,
  /^node:24-bookworm-slim@sha256:[a-f0-9]{64}$/u,
  'Docker runtime inventory must identify an immutable multi-architecture base-image digest',
);
assert(inventory.dpkgPackages.length > 0, 'Docker runtime inventory must contain Debian packages');
assert(inventory.pythonPackages.length > 0, 'Docker runtime inventory must contain Python packages');

for (const component of inventory.dpkgPackages) {
  assert(component.name);
  assert(component.version);
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

console.log(
  `runtime-component-inventory-test: ok (${inventory.dpkgPackages.length} Debian, `
  + `${inventory.pythonPackages.length} Python packages)`,
);
