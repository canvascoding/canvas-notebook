#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

const [
  amd64InventoryPath,
  arm64InventoryPath,
  amd64LinkagePath,
  arm64LinkagePath,
] = process.argv.slice(2);

assert(
  amd64InventoryPath && arm64InventoryPath && amd64LinkagePath && arm64LinkagePath,
  'usage: runtime-multiarch-compliance-test.mjs <amd64 inventory> <arm64 inventory> <amd64 linkage> <arm64 linkage>',
);

const policy = JSON.parse(fs.readFileSync(
  'docs/compliance/docker-native-distribution-policy.json',
  'utf8',
));
const amd64 = JSON.parse(fs.readFileSync(amd64InventoryPath, 'utf8'));
const arm64 = JSON.parse(fs.readFileSync(arm64InventoryPath, 'utf8'));
const amd64Linkage = JSON.parse(fs.readFileSync(amd64LinkagePath, 'utf8'));
const arm64Linkage = JSON.parse(fs.readFileSync(arm64LinkagePath, 'utf8'));

function sortedComponentEvidence(components, select) {
  return components
    .map((component) => select(component))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function verifyArchitecture(inventory, linkage, expectedArchitecture) {
  assert.equal(inventory.schemaVersion, 4);
  assert.match(inventory.platform, new RegExp(`(?:linux/)?${expectedArchitecture}`, 'u'));
  assert.equal(inventory.baseImage, policy.baseImage.reference);
  assert.equal(inventory.debianSnapshot, policy.debianSnapshot.timestamp);
  assert.equal(inventory.nativeComponents.find((entry) => entry.name === 'node')?.version, policy.baseImage.nodeVersion);

  const libvips = inventory.nativeComponents.find((entry) => entry.name === 'libvips');
  assert(libvips, `${expectedArchitecture} must inventory libvips`);
  assert.equal(libvips.version, policy.libvips.version);
  assert.equal(libvips.sourceUrl, policy.libvips.sourceUrl);
  assert.equal(libvips.sourceArchiveSha256, policy.libvips.sourceSha256);
  assert.equal(libvips.license, policy.libvips.license);
  assert.equal(libvips.linkage, 'shared');

  assert.deepEqual(inventory.installedSharpPrebuiltPackages, []);
  assert.deepEqual(
    inventory.sharpBuilds.map((entry) => entry.version).sort(),
    [...policy.libvips.sharpVersions].sort(),
  );
  for (const build of inventory.sharpBuilds) {
    assert.match(build.addonSha256, /^[a-f0-9]{64}$/u);
  }

  assert.match(linkage.platform, new RegExp(`(?:linux/)?${expectedArchitecture}`, 'u'));
  assert.equal(linkage.libvips.version, policy.libvips.version);
  assert.equal(linkage.libvips.linkage, 'shared');
  assert.equal(linkage.libvips.sourceArchiveSha256, policy.libvips.sourceSha256);
  assert.deepEqual(
    linkage.sharpBuilds.map((entry) => entry.version).sort(),
    [...policy.libvips.sharpVersions].sort(),
  );
  for (const build of linkage.sharpBuilds) {
    assert(
      build.ldd.some((line) => /libvips-cpp\.so[^=]*=> \/usr\/local\/lib\//u.test(line)),
      `${expectedArchitecture} ${build.packagePath} must link to /usr/local/libvips-cpp`,
    );
    assert(!build.ldd.some((line) => line.includes('@img/sharp')));
  }

  const expectedPostgresPackages = new Map([
    ['postgresql-client-18', policy.postgresql.clientVersion],
    ['libpq5', policy.postgresql.clientVersion],
    ['postgresql-client-common', policy.postgresql.commonVersion],
  ]);
  for (const [name, version] of expectedPostgresPackages) {
    assert.equal(
      inventory.dpkgPackages.find((entry) => entry.name === name)?.version,
      version,
      `${expectedArchitecture} must contain the reviewed ${name} build`,
    );
  }
}

verifyArchitecture(amd64, amd64Linkage, 'amd64');
verifyArchitecture(arm64, arm64Linkage, 'arm64');

for (const evidenceField of [
  'dockerfileSha256',
  'nativeDistributionPolicySha256',
  'pythonRequirementsSha256',
]) {
  assert.equal(
    amd64.evidence[evidenceField],
    arm64.evidence[evidenceField],
    `${evidenceField} must describe one immutable multi-architecture release source`,
  );
}

assert.deepEqual(
  sortedComponentEvidence(
    amd64.pythonPackages.filter((entry) => entry.managedBy === 'pip'),
    (entry) => ({
      name: entry.name.toLowerCase(),
      version: entry.version,
      licenseExpression: entry.licenseExpression,
      license: entry.license,
      licenseFileSha256: entry.licenseFiles.map((file) => file.sha256).sort(),
    }),
  ),
  sortedComponentEvidence(
    arm64.pythonPackages.filter((entry) => entry.managedBy === 'pip'),
    (entry) => ({
      name: entry.name.toLowerCase(),
      version: entry.version,
      licenseExpression: entry.licenseExpression,
      license: entry.license,
      licenseFileSha256: entry.licenseFiles.map((file) => file.sha256).sort(),
    }),
  ),
  'linux/amd64 and linux/arm64 must resolve the same reviewed Python package/license set',
);

assert.deepEqual(
  sortedComponentEvidence(amd64.globalNpmPackages, (entry) => ({
    name: entry.name,
    version: entry.version,
    packagePath: entry.packagePath,
    declaredLicense: entry.declaredLicense,
    noticeFileSha256: entry.noticeFiles.map((file) => file.sha256).sort(),
  })),
  sortedComponentEvidence(arm64.globalNpmPackages, (entry) => ({
    name: entry.name,
    version: entry.version,
    packagePath: entry.packagePath,
    declaredLicense: entry.declaredLicense,
    noticeFileSha256: entry.noticeFiles.map((file) => file.sha256).sort(),
  })),
  'linux/amd64 and linux/arm64 must retain the same global npm package/license set',
);

console.log(
  `runtime-multiarch-compliance-test: ok (${amd64.dpkgPackages.length} amd64 Debian, `
  + `${arm64.dpkgPackages.length} arm64 Debian, ${amd64.pythonPackages.length} Python each)`,
);
