#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const inventoryPath = process.argv[2] || '/app/docs/compliance/runtime-components.json';
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const requirementsPath = process.argv[3] || inventory.evidence?.pythonRequirementsPath;
const configuredNativePolicyPath = process.argv[4]
  || inventory.evidence?.nativeDistributionPolicyPath
  || '/app/docs/compliance/docker-native-distribution-policy.json';
const nativePolicyPath = fs.existsSync(configuredNativePolicyPath)
  ? configuredNativePolicyPath
  : 'docs/compliance/docker-native-distribution-policy.json';
const nativePolicy = JSON.parse(fs.readFileSync(
  nativePolicyPath,
  'utf8',
));
const thirdPartyManifest = JSON.parse(fs.readFileSync('docs/compliance/third-party-components.json', 'utf8'));

function normalizePythonName(value) {
  return String(value).toLowerCase().replace(/[_.]+/gu, '-');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

assert.equal(inventory.schemaVersion, 4);
assert.match(
  inventory.baseImage,
  /^node:24-bookworm-slim@sha256:[a-f0-9]{64}$/u,
  'Docker runtime inventory must identify an immutable multi-architecture base-image digest',
);
assert.match(inventory.platform, /^(?:linux\/)?(?:amd64|arm64|ppc64le)(?:\/v8)?$/u);
assert.equal(inventory.debianSnapshot, nativePolicy.debianSnapshot.timestamp);
assert.match(inventory.evidence.dockerfileSha256, /^[a-f0-9]{64}$/u);
assert.match(inventory.evidence.nativeDistributionPolicySha256, /^[a-f0-9]{64}$/u);
assert.match(inventory.evidence.pythonRequirementsSha256, /^[a-f0-9]{64}$/u);
assert.equal(inventory.evidence.dockerfileSha256, sha256File('Dockerfile'));
assert.equal(inventory.evidence.nativeDistributionPolicySha256, sha256File(nativePolicyPath));
assert.equal(inventory.evidence.pythonRequirementsSha256, sha256File(requirementsPath));
assert.equal(inventory.nativeComponents.length, 2);
assert.equal(inventory.nativeComponents[0].name, 'node');
assert.equal(inventory.nativeComponents[0].version, nativePolicy.baseImage.nodeVersion);
assert(
  inventory.nativeComponents[0].noticeFiles.some((entry) => (
    entry.path === '/usr/local/LICENSE' && /^[a-f0-9]{64}$/u.test(entry.sha256 || '')
  )),
  'the Node runtime must retain its aggregated upstream LICENSE file',
);
const libvips = inventory.nativeComponents.find((component) => component.name === 'libvips');
assert(libvips, 'the Docker runtime must inventory the Canvas-built shared libvips');
assert.equal(libvips.version, nativePolicy.libvips.version);
assert.equal(libvips.sourceUrl, nativePolicy.libvips.sourceUrl);
assert.equal(libvips.sourceArchiveSha256, nativePolicy.libvips.sourceSha256);
assert.equal(libvips.license, 'LGPL-2.1-or-later');
assert.equal(libvips.linkage, 'shared');
assert(inventory.dpkgPackages.length > 0, 'Docker runtime inventory must contain Debian packages');
assert(inventory.dpkgSourcePackages.length > 0, 'Docker runtime inventory must map Debian source packages');
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

const sourcePackageKeys = new Set(inventory.dpkgSourcePackages.map((component) => (
  `${component.name}@${component.version}`
)));
for (const component of inventory.dpkgPackages) {
  assert(
    sourcePackageKeys.has(`${component.sourcePackage}@${component.sourceVersion}`),
    `${component.name}@${component.version} needs an exact source-package offer`,
  );
}
for (const component of inventory.dpkgSourcePackages) {
  assert(component.name);
  assert(component.version);
  assert.match(component.sourcePageUrl, /^https:\/\//u);
  if (component.version.includes('.pgdg')) {
    assert(
      component.sourceArtifacts.length > 0,
      `${component.name}@${component.version} needs immutable PGDG source artifacts`,
    );
    for (const artifact of component.sourceArtifacts) {
      assert.match(artifact.url, /^https:\/\//u);
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
    }
  }
}

const tokenizersEvidence = thirdPartyManifest.components.find((component) => component.name === 'docker-python:tokenizers');
const tokenizersLicensePath = 'docs/compliance/license-texts/tokenizers-0.23.2-APACHE-2.0.txt';
assert(tokenizersEvidence, 'the tokenizers wheel without license metadata needs exact source evidence');
assert.equal(tokenizersEvidence.versionOrCommit, '0.23.2 / 88a4498ad4ea1a9487b0a9b0ff881383fd5a06a3');
assert.equal(tokenizersEvidence.sourceUrl, 'https://github.com/huggingface/tokenizers/tree/88a4498ad4ea1a9487b0a9b0ff881383fd5a06a3');
assert.equal(tokenizersEvidence.verifiedLicense, 'Apache-2.0');
assert.equal(tokenizersEvidence.licenseTextRef, tokenizersLicensePath);
assert.equal(tokenizersEvidence.licenseTextSha256, 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4');
assert.equal(sha256File(tokenizersLicensePath), tokenizersEvidence.licenseTextSha256);
assert(inventory.pythonPackages.some((component) => normalizePythonName(component.name) === 'tokenizers' && component.version === '0.23.2'));
const tqdmEvidence = thirdPartyManifest.components.find((component) => component.name === 'docker-python:tqdm');
const tqdmLicensePath = 'docs/compliance/license-texts/tqdm-4.70.1-LICENCE.txt';
assert(tqdmEvidence, 'the tqdm dual-license review must remain visible');
assert.equal(tqdmEvidence.versionOrCommit, '4.70.1 / 9cf5a12b1f955468a17f0ba3c59092b23e4258ac');
assert.equal(tqdmEvidence.policyDecision, 'review_required');
assert.equal(tqdmEvidence.verifiedLicense, 'MPL-2.0 AND MIT');
assert.equal(tqdmEvidence.licenseTextRef, tqdmLicensePath);
assert.equal(tqdmEvidence.licenseTextSha256, 'fcff87c3a47ce8028a8512aa182d4fcf0ad1c90544ee75cf9b343684cac194de');
assert.equal(sha256File(tqdmLicensePath), tqdmEvidence.licenseTextSha256);
assert(inventory.pythonPackages.some((component) => normalizePythonName(component.name) === 'tqdm' && component.version === '4.70.1'));

for (const component of inventory.pythonPackages) {
  assert(component.name);
  assert(component.version);
  assert(['deb', 'pip'].includes(component.managedBy));
  for (const licenseFile of component.licenseFiles) {
    assert(licenseFile.path);
    assert.doesNotMatch(
      licenseFile.path,
      /(?:\/__pycache__\/|\.pyc$)/u,
      `${component.name}@${component.version} must not classify architecture-specific Python bytecode as license evidence`,
    );
    assert.match(
      licenseFile.sha256 || '',
      /^[a-f0-9]{64}$/u,
      `${component.name}@${component.version} has an unreadable Python license file`,
    );
  }
  assert(
    component.licenseExpression
      || component.license
      || component.licenseClassifiers?.some((classifier) => (
        /^License :: OSI Approved :: /u.test(classifier)
      ))
      || component.licenseFiles.length > 0
      || (normalizePythonName(component.name) === 'tokenizers' && component.version === '0.23.2')
      || (
        component.managedBy === 'deb'
        && component.debianPackage
        && inventory.dpkgPackages.some((candidate) => candidate.name === component.debianPackage)
      ),
    `${component.name}@${component.version} needs license metadata or a packaged license file`,
  );
}

for (const optionalName of [
  'anyio', 'av', 'ctranslate2', 'faster-whisper', 'filelock', 'fsspec', 'h11',
  'hf-xet', 'httpcore', 'httpx', 'huggingface-hub', 'tokenizers', 'tqdm',
]) {
  assert(
    !inventory.pythonPackages.some((component) => normalizePythonName(component.name) === optionalName),
    `${optionalName} must not be installed in the distributed Docker image`,
  );
}

const packagingComponent = inventory.pythonPackages.find((component) => (
  normalizePythonName(component.name) === 'packaging'
));
assert(packagingComponent, 'the locked Python packaging distribution must be inventoried');
assert(
  packagingComponent.licenseFiles.every((entry) => entry.path.includes('.dist-info/licenses/')),
  'the packaging module directory named licenses must not be mistaken for PEP 639 license evidence',
);


assert(requirementsPath, 'the runtime Python lock path must be available');
const requirements = fs.readFileSync(requirementsPath, 'utf8');
const lockedPythonPackages = new Map(
  [...requirements.matchAll(/^([a-z0-9][a-z0-9._-]*)==([^\s\\]+)/gmi)]
    .map((match) => [normalizePythonName(match[1]), match[2]]),
);
assert(lockedPythonPackages.size > 0, 'the runtime Python lock must contain exact versions');
assert.match(requirements, /--hash=sha256:[a-f0-9]{64}/u);
const pipManagedPackages = inventory.pythonPackages.filter((component) => component.managedBy === 'pip');
assert.equal(pipManagedPackages.length, lockedPythonPackages.size);
for (const component of pipManagedPackages) {
  assert.equal(
    component.version,
    lockedPythonPackages.get(normalizePythonName(component.name)),
    `${component.name} must match the cross-platform hash lock`,
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

assert.deepEqual(
  inventory.sharpBuilds.map((component) => component.version).sort(),
  [...nativePolicy.libvips.sharpVersions].sort(),
  'both shipped sharp versions must be rebuilt against the Canvas shared libvips',
);
for (const component of inventory.sharpBuilds) {
  assert.match(component.addonSha256 || '', /^[a-f0-9]{64}$/u);
  assert(component.addonPath.startsWith('/app/node_modules/'));
}
for (const component of inventory.installedSharpPrebuiltPackages) {
  assert(
    !nativePolicy.excludedPrebuiltPackagePrefixes.some((prefix) => component.name.startsWith(prefix)),
    `${component.name}@${component.version} must not be distributed in Canvas Docker images`,
  );
}

console.log(
  `runtime-component-inventory-test: ok (${inventory.dpkgPackages.length} Debian, `
  + `${inventory.pythonPackages.length} Python, `
  + `${inventory.globalNpmPackages.length} global npm packages)`,
);
