import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  generateThirdPartyComplianceArtifacts,
  thirdPartyCompliancePaths,
} from './third-party-license-inventory';

const artifacts = generateThirdPartyComplianceArtifacts();
const { inventory } = artifacts;
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
};
const lockfile = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, {
    version?: string;
    resolved?: string;
    integrity?: string;
    optional?: boolean;
  }>;
};
const licenseCache = JSON.parse(fs.readFileSync(
  thirdPartyCompliancePaths.licenseCache,
  'utf8',
)) as {
  schemaVersion?: number;
  entries?: Record<string, {
    packageResolved?: string | null;
    packageIntegrity?: string | null;
    lookupCompleted?: boolean;
    sourceRevision?: string | null;
    licenseText?: string | null;
    verificationNote?: string | null;
    copyrightNotices?: string[];
  }>;
};
const licensePolicy = JSON.parse(fs.readFileSync(
  thirdPartyCompliancePaths.policy,
  'utf8',
)) as {
  packageOverrides?: Record<string, { licenseTextPath?: string | null }>;
  packageUsageOverrides?: Array<{
    namePrefix: string;
    usage: string;
    distributedIn: string[];
    reason: string;
  }>;
};
const nativeDistributionPolicy = JSON.parse(fs.readFileSync(
  'docs/compliance/docker-native-distribution-policy.json',
  'utf8',
)) as {
  baseImage: { reference: string; nodeVersion: string };
  debianSnapshot: { timestamp: string };
  postgresql: {
    clientVersion: string;
    commonVersion: string;
    binaryArtifacts: Record<string, Record<string, string>>;
    sourceArtifacts: Array<{ url: string; sha256: string }>;
  };
  pythonRequirements: string;
  libvips: {
    version: string;
    sourceUrl: string;
    sourceSha256: string;
    license: string;
    licenseTextPath: string;
    sharpVersions: string[];
    linkage: string;
    relinkingGuide: string;
  };
  excludedPrebuiltPackagePrefixes: string[];
};
const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
const nativeBuildWorkflow = fs.readFileSync('.github/workflows/build-both.yml', 'utf8');
const runtimePythonRequirements = fs.readFileSync(
  nativeDistributionPolicy.pythonRequirements,
  'utf8',
);

assert.equal(
  packageJson.dependencies?.['@jspreadsheet/react'],
  undefined,
  'unused @jspreadsheet/react must not reintroduce the license-required formula-pro dependency',
);
assert.equal(
  packageJson.dependencies?.['@remotion/google-fonts'],
  undefined,
  'unused Remotion packages must not reintroduce an organization-size-dependent commercial license',
);
assert.equal(
  fs.readFileSync(thirdPartyCompliancePaths.inventory, 'utf8'),
  artifacts.inventoryJson,
  'machine-readable third-party inventory must be regenerated after dependency changes',
);
assert.equal(
  fs.readFileSync(thirdPartyCompliancePaths.notices, 'utf8'),
  artifacts.noticesMarkdown,
  'THIRD_PARTY_NOTICES.md must be regenerated after dependency changes',
);
assert.equal(
  inventory.summary.npmComponents,
  Object.entries(lockfile.packages)
    .filter(([packagePath, value]) => packagePath.startsWith('node_modules/') && value.version)
    .length,
);
assert.equal(inventory.releaseGate.approvalStatus, 'approved');
assert.equal(inventory.releaseGate.approvalReviewedBy, 'Frank Alexander Weber');
assert.equal(inventory.releaseGate.approvalReviewedAt, '2026-07-17');
assert.equal(inventory.releaseGate.status, 'approved');
assert.deepEqual(inventory.releaseGate.blockers, []);

const sharpUsageOverride = licensePolicy.packageUsageOverrides?.find((entry) => (
  entry.namePrefix === '@img/sharp-'
));
assert(sharpUsageOverride, 'prebuilt sharp payloads need an explicit non-distribution classification');
assert.equal(sharpUsageOverride.usage, 'development-only');
assert.deepEqual(sharpUsageOverride.distributedIn, ['source-development-install']);
assert.match(sharpUsageOverride.reason, /does not redistribute/u);

assert.equal(nativeDistributionPolicy.libvips.version, '8.18.3');
assert.equal(nativeDistributionPolicy.libvips.license, 'LGPL-2.1-or-later');
assert.equal(nativeDistributionPolicy.libvips.linkage, 'shared');
assert.deepEqual(nativeDistributionPolicy.libvips.sharpVersions.sort(), ['0.34.5', '0.35.3']);
assert.deepEqual(nativeDistributionPolicy.excludedPrebuiltPackagePrefixes, ['@img/sharp-']);
assert.match(
  fs.readFileSync(nativeDistributionPolicy.libvips.licenseTextPath, 'utf8'),
  /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/u,
);
assert.match(
  fs.readFileSync(nativeDistributionPolicy.libvips.relinkingGuide, 'utf8'),
  /Replace and verify/u,
);

for (const requiredDockerFragment of [
  `ARG NODE_BASE_IMAGE=${nativeDistributionPolicy.baseImage.reference}`,
  `ARG DEBIAN_SNAPSHOT=${nativeDistributionPolicy.debianSnapshot.timestamp}`,
  `ARG LIBVIPS_VERSION=${nativeDistributionPolicy.libvips.version}`,
  `ARG LIBVIPS_SHA256=${nativeDistributionPolicy.libvips.sourceSha256}`,
  'Types: deb deb-src',
  'URIs: http://snapshot.debian.org/archive/debian/',
  "sed -i 's#URIs: http://#URIs: https://#g'",
  'FROM canvas-base AS libvips-build',
  'libarchive13 libexif12 libexpat1 libfontconfig1 libglib2.0-0 libheif1',
  '--libdir=lib --buildtype=release',
  'SHARP_FORCE_GLOBAL_LIBVIPS=1',
  'npm --prefix node_modules/sharp run build',
  'npm --prefix node_modules/next/node_modules/sharp run build',
  "find node_modules -type d -path '*/@img/sharp-*'",
  '--require-hashes -r /app/requirements/runtime-python.txt',
  'capture-runtime-component-inventory.mjs',
  'runtime-component-inventory-test.mjs',
  'sharp-runtime-linkage-test.mjs',
]) {
  assert(
    dockerfile.includes(requiredDockerFragment),
    `Dockerfile must retain native compliance control: ${requiredDockerFragment}`,
  );
}
assert.doesNotMatch(
  dockerfile,
  /\blibvips42\b/u,
  'the runtime image must not add a second Debian libvips binary beside the source-built shared library',
);
for (const requiredWorkflowFragment of [
  'Verify amd64 native compliance payload',
  'Verify arm64 native compliance payload',
  'runtime-component-inventory-test.mjs',
  'runtime-multiarch-compliance-test.mjs',
  'sharp-linkage-linux-amd64.json',
  'sharp-linkage-linux-arm64.json',
  'vips-8.18.3.tar.xz',
  'Package native compliance evidence',
  'canvas-native-compliance-${{ needs.source.outputs.release_version }}.tar.gz',
]) {
  assert(
    nativeBuildWorkflow.includes(requiredWorkflowFragment),
    `multi-architecture release workflow must retain: ${requiredWorkflowFragment}`,
  );
}
assert.equal(
  (dockerfile.match(/find node_modules -type d -path '\*\/@img\/sharp-\*'/gu) || []).length,
  2,
  'prebuilt sharp payloads must be removed after the initial install and after production pruning',
);
for (const artifact of [
  nativeDistributionPolicy.postgresql.binaryArtifacts.common,
  nativeDistributionPolicy.postgresql.binaryArtifacts['linux/amd64'],
  nativeDistributionPolicy.postgresql.binaryArtifacts['linux/arm64'],
]) {
  for (const value of Object.values(artifact)) {
    if (/^[a-f0-9]{64}$/u.test(value)) {
      assert(dockerfile.includes(value), `Dockerfile must verify PostgreSQL artifact ${value}`);
    }
  }
}
for (const artifact of nativeDistributionPolicy.postgresql.sourceArtifacts) {
  assert.match(artifact.url, /^https:\/\/apt\.postgresql\.org\//u);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
}

const pythonRequirementBody = runtimePythonRequirements
  .split(/\r?\n/u)
  .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
  .join('\n');
const pythonEntries = pythonRequirementBody
  .split(/(?=^[a-z0-9][a-z0-9._-]*==)/gimu)
  .map((block) => {
    const match = block.match(/^([a-z0-9][a-z0-9._-]*)==([^\s\\]+)/iu);
    assert(match, `invalid Python requirement block: ${block}`);
    return [match[1], match[2], block] as const;
  });
assert.equal(pythonEntries.length, 45, 'the Docker Python lock must retain the reviewed package set');
assert.equal(new Set(pythonEntries.map((entry) => entry[0].toLowerCase())).size, pythonEntries.length);
for (const [name, version, hashes] of pythonEntries) {
  assert(version, `${name} must use an exact Python version`);
  assert.match(hashes, /--hash=sha256:[a-f0-9]{64}/u, `${name} must retain wheel hashes`);
  assert.doesNotMatch(hashes, /--hash=sha256:(?![a-f0-9]{64})/u);
}

for (const [packagePath, lockPackage] of Object.entries(lockfile.packages)) {
  if (
    !packagePath.startsWith('node_modules/')
    || !lockPackage.version
    || !lockPackage.optional
    || !lockPackage.resolved?.startsWith('http')
  ) {
    continue;
  }
  const withoutRoot = packagePath.replace(/^node_modules\//u, '');
  const nestedPath = withoutRoot.split('/node_modules/').at(-1) || withoutRoot;
  const segments = nestedPath.split('/');
  const name = nestedPath.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  const override = licensePolicy.packageOverrides?.[`${name}@${lockPackage.version}`]
    || licensePolicy.packageOverrides?.[name];
  if (override?.licenseTextPath) continue;
  assert(
    licenseCache.entries?.[`${packagePath}@${lockPackage.version}`],
    `optional package ${name}@${lockPackage.version} needs lockfile-tarball evidence for platform-independent notices`,
  );
}

const excalidraw = inventory.components.find((component) => (
  component.name === '@excalidraw/excalidraw' && component.versionOrCommit === '0.18.1'
));
assert(excalidraw, 'the pinned Excalidraw package must be inventoried');
assert.equal(excalidraw.verifiedLicense, 'MIT');
assert(excalidraw.copyrightNotices.includes('Copyright (c) 2020 Excalidraw'));
assert(excalidraw.licenseTextSha256);

const excalidrawFonts = inventory.components.find((component) => (
  component.name === '@excalidraw/excalidraw-font-assets'
));
assert(excalidrawFonts, 'self-hosted Excalidraw font assets must be inventoried separately');
assert.match(excalidrawFonts.versionOrCommit, /a2ec2889babf7d2295469c6d90ebe77fae57df84/u);

const dataUriToBuffer = inventory.components.find((component) => (
  component.name === 'data-uri-to-buffer' && component.versionOrCommit === '4.0.1'
));
assert(dataUriToBuffer, 'the nested data-uri-to-buffer release must be inventoried');
assert.equal(dataUriToBuffer.policyDecision, 'allowed');
assert.match(
  dataUriToBuffer.reviewNotes || '',
  /exact npm tarball README license section/u,
  'Setext README license sections must remain a supported exact-package evidence source',
);
assert(
  dataUriToBuffer.copyrightNotices.some((notice) => (
    notice === 'Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net>'
  )),
  'README license evidence must preserve and decode the attributable MIT copyright notice',
);

for (const [name, version] of [
  ['@types/trusted-types', '2.0.7'],
  ['@types/yauzl', '2.10.3'],
] as const) {
  const component = inventory.components.find((candidate) => (
    candidate.name === name && candidate.versionOrCommit === version
  ));
  assert(component, `${name}@${version} must be inventoried`);
  assert.equal(
    component.policyDecision,
    'allowed',
    `${name}@${version} must retain the exact MIT evidence from its non-package/ npm tarball root`,
  );
  assert.equal(component.licenseTextSha256, 'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383');
  assert(component.copyrightNotices.includes('Copyright (c) Microsoft Corporation.'));
  assert.match(
    component.reviewNotes || '',
    /registry\.npmjs\.org\/@types\/.+#LICENSE/u,
    `${name}@${version} must cite the exact npm tarball LICENSE`,
  );
}

const highlightjsVue = inventory.components.find((component) => (
  component.name === 'highlightjs-vue' && component.versionOrCommit === '1.0.0'
));
assert(highlightjsVue, 'highlightjs-vue@1.0.0 must be inventoried');
assert.equal(highlightjsVue.verifiedLicense, 'CC0-1.0');
assert.equal(highlightjsVue.policyDecision, 'allowed');
assert.equal(highlightjsVue.licenseTextSha256, 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499');
assert.deepEqual(
  highlightjsVue.copyrightNotices,
  [],
  'CC0 must not turn legal-code references to copyright into false attribution notices',
);
assert.match(highlightjsVue.sourceUrl, /2a0d197ec24ba70e019e12a13bd42f006124506a/u);

for (const [name, version] of [
  ['@apm-js-collab/code-transformer-bundler-plugins', '0.5.0'],
  ['@better-auth/utils', '0.4.2'],
  ['@eigenpal/docx-js-editor', '0.5.3'],
  ['client-only', '0.0.1'],
  ['dingbat-to-unicode', '1.0.1'],
  ['github-from-package', '0.0.0'],
  ['https', '1.0.0'],
  ['is-reference', '1.2.1'],
  ['server-only', '0.0.1'],
  ['webworkify', '1.5.0'],
] as const) {
  const component = inventory.components.find((candidate) => (
    candidate.name === name && candidate.versionOrCommit === version
  ));
  assert(component, `${name}@${version} must be inventoried`);
  assert.equal(component.policyDecision, 'allowed');
  assert.equal(component.reviewedBy, 'Frank Alexander Weber');
  assert.equal(component.reviewedAt, '2026-07-17');
  assert(component.licenseTextSha256, `${name}@${version} must ship its selected license terms`);
  assert(component.copyrightNotices.length > 0, `${name}@${version} must ship best-evidence attribution`);
  assert.match(component.reviewNotes || '', /documented residual attribution risk/u);
}

const httpsPlaceholder = inventory.components.find((component) => (
  component.name === 'https' && component.versionOrCommit === '1.0.0'
));
assert(httpsPlaceholder, 'https@1.0.0 must be inventoried');
assert.equal(httpsPlaceholder.verifiedLicense, 'ISC');
assert.equal(httpsPlaceholder.policyDecision, 'allowed');
assert.equal(
  httpsPlaceholder.licenseTextRef,
  'docs/compliance/license-texts/https-1.0.0-ISC.txt',
);
assert(httpsPlaceholder.licenseTextSha256);
assert(httpsPlaceholder.copyrightNotices.includes(
  'Copyright (c) hardus van der berg and contributors',
));
assert.equal(
  httpsPlaceholder.sourceUrl,
  'https://registry.npmjs.org/https/-/https-1.0.0.tgz',
);
assert.match(httpsPlaceholder.reviewNotes || '', /node:https/u);

const isReference = inventory.components.find((component) => (
  component.name === 'is-reference' && component.versionOrCommit === '1.2.1'
));
assert(isReference, 'is-reference@1.2.1 must be inventoried');
assert.equal(isReference.verifiedLicense, 'MIT');
assert.equal(isReference.policyDecision, 'allowed');
assert(isReference.licenseTextSha256, 'is-reference must retain the canonical MIT terms');
assert(isReference.copyrightNotices.includes('Copyright (c) Rich Harris and contributors'));
assert.match(isReference.sourceUrl, /9d2719fbcc2059567203063f1e7b65d7831bfd64/u);
assert.match(isReference.reviewNotes || '', /annotated tag v1\.2\.1/u);

const minimist = inventory.components.find((component) => (
  component.name === 'minimist' && component.versionOrCommit === '1.2.8'
));
assert(minimist, 'minimist@1.2.8 must be inventoried');
assert.equal(minimist.verifiedLicense, 'MIT');
assert.equal(minimist.policyDecision, 'allowed');
assert.equal(minimist.licenseTextSha256, '435a6722c786b0a56fbe7387028f1d9d3f3a2d0fb615bb8fee118727c3f59b7b');
assert(minimist.copyrightNotices.includes(
  'Copyright (c) 2013 James Halliday and contributors',
));
assert.match(minimist.sourceUrl, /6901ee286bc4c16da6830b48b46ce1574703cea1/u);
assert.match(minimist.reviewNotes || '', /b7ce0ded1e840ccef6f59b1866694e93f6f582e8/u);

const reactRemoveScrollBar = inventory.components.find((component) => (
  component.name === 'react-remove-scroll-bar' && component.versionOrCommit === '2.3.8'
));
assert(reactRemoveScrollBar, 'react-remove-scroll-bar@2.3.8 must be inventoried');
assert.equal(reactRemoveScrollBar.verifiedLicense, 'MIT');
assert.equal(reactRemoveScrollBar.policyDecision, 'allowed');
assert(reactRemoveScrollBar.licenseTextSha256);
assert(reactRemoveScrollBar.copyrightNotices.includes(
  'Copyright (c) 2025 Anton Korzunov <thekashey@gmail.com>',
));
assert.equal(
  reactRemoveScrollBar.sourceUrl,
  'https://registry.npmjs.org/react-remove-scroll-bar/-/react-remove-scroll-bar-2.3.8.tgz',
);
assert.match(
  reactRemoveScrollBar.reviewNotes || '',
  /7301c160fda44cb8cf2b9fdfde61efad35736196/u,
);

const serverOnly = inventory.components.find((component) => (
  component.name === 'server-only' && component.versionOrCommit === '0.0.1'
));
assert(serverOnly, 'server-only@0.0.1 must be inventoried');
assert.equal(serverOnly.verifiedLicense, 'MIT');
assert.equal(serverOnly.policyDecision, 'allowed');
assert(serverOnly.licenseTextSha256, 'server-only must retain the canonical MIT terms');
assert(serverOnly.copyrightNotices.includes(
  'Copyright (c) Sebastian Markbåge and contributors',
));
assert.equal(
  serverOnly.sourceUrl,
  'https://registry.npmjs.org/server-only/-/server-only-0.0.1.tgz',
);
assert.match(serverOnly.reviewNotes || '', /provides no author, repository, provenance/u);

const tr46Legacy = inventory.components.find((component) => (
  component.name === 'tr46' && component.versionOrCommit === '0.0.3'
));
assert(tr46Legacy, 'tr46@0.0.3 must be inventoried');
assert.equal(tr46Legacy.verifiedLicense, 'MIT AND Unicode-DFS-2015');
assert.equal(tr46Legacy.policyDecision, 'allowed');
assert.equal(
  tr46Legacy.licenseTextSha256,
  'c27a1b74b10405fb6be679f0f663995b8b437fa71f4305feaac46daf0a91fc15',
);
assert(tr46Legacy.copyrightNotices.includes('Copyright (c) 2016 Sebastian Mayr'));
assert(tr46Legacy.copyrightNotices.includes(
  'Copyright © 1991-2015 Unicode, Inc. All rights reserved.',
));
assert.match(tr46Legacy.reviewNotes || '', /b6b39724dca9011113a08d9d6910204062b58169e98952acdfbd19bf2c31bbff/u);

const tr46Current = inventory.components.find((component) => (
  component.name === 'tr46' && component.versionOrCommit === '6.0.0'
));
assert(tr46Current, 'tr46@6.0.0 must be inventoried');
assert.equal(tr46Current.verifiedLicense, 'MIT AND Unicode-3.0');
assert.equal(tr46Current.policyDecision, 'allowed');
assert.equal(
  tr46Current.licenseTextSha256,
  '0db59b35b21da5e5a5d4da3b49bcffc4cc50796c509de0e090d804621142dee8',
);
assert(tr46Current.copyrightNotices.includes('Copyright (c) Sebastian Mayr'));
assert(tr46Current.copyrightNotices.includes('Copyright © 2025 Unicode, Inc.'));
assert.match(tr46Current.reviewNotes || '', /c45bd284e01f0845bc3c3b1d7594cd7b9ee8b955ddc850882b8e1dc5d0cba95d/u);

const webworkify = inventory.components.find((component) => (
  component.name === 'webworkify' && component.versionOrCommit === '1.5.0'
));
assert(webworkify, 'webworkify@1.5.0 must be inventoried');
assert.equal(webworkify.verifiedLicense, 'MIT');
assert.equal(webworkify.policyDecision, 'allowed');
assert.equal(webworkify.licenseTextSha256, '435a6722c786b0a56fbe7387028f1d9d3f3a2d0fb615bb8fee118727c3f59b7b');
assert(webworkify.copyrightNotices.includes(
  'Copyright (c) James Halliday and contributors',
));
assert.match(webworkify.sourceUrl, /baf2884256768aea6c36be1ea6e1efb2144fcfbc/u);
assert.match(webworkify.reviewNotes || '', /embedded in pica's distributed browser bundles/u);

assert.equal(licenseCache.schemaVersion, 6);
for (const [cacheKey, entry] of Object.entries(licenseCache.entries || {})) {
  const packagePath = cacheKey.slice(0, cacheKey.lastIndexOf('@'));
  const lockPackage = lockfile.packages[packagePath];
  assert(lockPackage, `${cacheKey} must still resolve to a package-lock entry`);
  assert.equal(entry.lookupCompleted, true, `${cacheKey} must record a completed evidence lookup`);
  assert.equal(entry.packageResolved, lockPackage.resolved || null);
  assert.equal(entry.packageIntegrity, lockPackage.integrity || null);
}
const sharpLibvipsComponents = inventory.components.filter((component) => (
  component.name.startsWith('@img/sharp-libvips-')
));
assert.equal(sharpLibvipsComponents.length, 20);
for (const component of sharpLibvipsComponents) {
  assert.equal(component.policyDecision, 'review_required');
  assert.equal(component.usage, 'development-only');
  assert.deepEqual(component.distributedIn, ['source-development-install']);
  assert.equal(
    component.licenseTextRef,
    null,
    `${component.name}@${component.versionOrCommit} must not use the Apache build-script license as LGPL evidence`,
  );
  assert.equal(component.licenseTextSha256, null);
  assert.deepEqual(component.copyrightNotices, []);
  assert.match(component.sourceUrl, /\/tree\/[0-9a-f]{40}$/u);
  assert.match(component.reviewNotes || '', /repository-root Apache-2\.0 license/u);
}

const sharpCompositeBinaryComponents = inventory.components.filter((component) => (
  component.name === '@img/sharp-wasm32'
  || component.name.startsWith('@img/sharp-win32-')
));
assert.equal(sharpCompositeBinaryComponents.length, 8);
for (const component of sharpCompositeBinaryComponents) {
  assert.equal(component.policyDecision, 'review_required');
  assert.equal(component.usage, 'development-only');
  assert.deepEqual(component.distributedIn, ['source-development-install']);
  assert(component.licenseTextSha256, 'the exact sharp Apache portion must remain available');
  assert(component.copyrightNotices.includes('Copyright 2013 Lovell Fuller and others.'));
  assert.match(component.sourceUrl, /\/tree\/[0-9a-f]{40}$/u);
  assert.match(component.reviewNotes || '', /LICENSE covers only part of the declared/u);
}
const allSharpPrebuiltComponents = inventory.components.filter((component) => (
  component.name.startsWith('@img/sharp-')
));
assert.equal(allSharpPrebuiltComponents.length, 50);
assert(allSharpPrebuiltComponents.every((component) => component.usage === 'development-only'));
assert(allSharpPrebuiltComponents.every((component) => (
  component.distributedIn.join(',') === 'source-development-install'
)));
assert(
  inventory.components.every((component) => (
    !component.reviewNotes?.includes('Package author metadata:')
  )),
  'generated compliance artifacts must not depend on platform-specific optional package installation',
);

for (const name of [
  'docker-python:flatbuffers',
  'docker-python:magika',
  'docker-python:markitdown',
  'docker-global-npm:@sigstore/verify',
  'docker-global-npm:imurmurhash',
  'docker-global-npm:spdx-license-ids',
]) {
  const component = inventory.components.find((candidate) => candidate.name === name);
  assert(component, `${name} must be represented outside the application package-lock inventory`);
  assert.equal(component.policyDecision, 'allowed');
  assert.equal(component.distributedIn.join(','), 'docker-image');
  assert(component.licenseTextSha256);
}

const canvasLibvips = inventory.components.find((component) => (
  component.name === 'canvas-built-libvips'
));
assert(canvasLibvips, 'the Canvas-built shared libvips must be inventoried');
assert.equal(canvasLibvips.policyDecision, 'allowed');
assert.equal(canvasLibvips.verifiedLicense, 'LGPL-2.1-or-later');
assert.equal(canvasLibvips.licenseTextRef, nativeDistributionPolicy.libvips.licenseTextPath);
assert(canvasLibvips.licenseTextSha256);
assert.equal(canvasLibvips.modified, false);
assert.match(canvasLibvips.reviewNotes || '', /replaceable shared library/u);

const nodeDockerBase = inventory.components.find((component) => (
  component.name === 'node-docker-base'
));
assert(nodeDockerBase, 'the immutable Node/Debian base-image aggregate must be inventoried');
assert.equal(nodeDockerBase.policyDecision, 'allowed');
assert.equal(nodeDockerBase.versionOrCommit, nativeDistributionPolicy.baseImage.reference);
assert.equal(nodeDockerBase.licenseTextRef, null);
assert.equal(nodeDockerBase.licenseTextSha256, null);
assert.equal(nodeDockerBase.reviewedBy, 'Frank Alexander Weber');
assert.equal(nodeDockerBase.reviewedAt, '2026-07-17');
assert.match(nodeDockerBase.reviewNotes || '', /aggregate container position/u);
for (const name of [
  'docker-global-npm:@npmcli/agent',
  'docker-global-npm:err-code',
  'docker-global-npm:spdx-exceptions',
]) {
  const component = inventory.components.find((candidate) => candidate.name === name);
  assert(component, `${name} must remain visible as a global npm runtime package`);
  assert.equal(component.policyDecision, 'allowed');
  assert.equal(component.reviewedBy, 'Frank Alexander Weber');
  assert.equal(component.reviewedAt, '2026-07-17');
  assert(component.licenseTextSha256);
  assert(component.copyrightNotices.length > 0);
  assert.match(component.reviewNotes || '', /documented residual attribution risk/u);
}

const exactSourceComponents = [
  ['@aws-sdk/credential-provider-http', '3.972.59', 'ceb9aeec0cc3c34d2713ef09a6ee61fb1595ea19'],
  ['@aws-sdk/credential-provider-login', '3.972.63', 'ceb9aeec0cc3c34d2713ef09a6ee61fb1595ea19'],
  ['@aws-sdk/nested-clients', '3.997.31', 'ceb9aeec0cc3c34d2713ef09a6ee61fb1595ea19'],
  ['@swc/counter', '0.1.3', '259271f1326b75ce7103b571284dd17fdd42b6c7'],
  ['mj-context-menu', '0.6.1', '8ddd26a41f834cd23b9bb20737dfae5fa9b05eb4'],
] as const;
for (const [name, version, revision] of exactSourceComponents) {
  const component = inventory.components.find((candidate) => (
    candidate.name === name && candidate.versionOrCommit === version
  ));
  assert(component, `${name}@${version} must be inventoried`);
  assert.equal(component.policyDecision, 'allowed');
  assert.match(
    component.reviewNotes || '',
    new RegExp(revision, 'u'),
    `${name}@${version} must retain its exact upstream source revision`,
  );
  assert(component.licenseTextSha256);
}

for (const name of ['github-from-package', 'webworkify']) {
  const component = inventory.components.find((candidate) => candidate.name === name);
  assert(component, `${name} must be inventoried`);
  assert.equal(
    component.policyDecision,
    'allowed',
    `${name} must retain the exact terms and the reviewed best-evidence attribution`,
  );
  assert.equal(component.reviewedBy, 'Frank Alexander Weber');
}

const terser = inventory.components.find((component) => (
  component.name === 'terser' && component.versionOrCommit === '5.49.0'
));
assert(terser, 'terser@5.49.0 must be inventoried from the synchronized lockfile');
assert.deepEqual(
  terser.copyrightNotices,
  ['Copyright 2012-2018 (c) Mihai Bazon <mihai.bazon@gmail.com>'],
  'Terser README instructions about preserving copyright comments are not attributions',
);

for (const component of inventory.components) {
  assert(component.name);
  assert(component.versionOrCommit);
  assert(component.sourceUrl);
  assert(component.packagePathOrArtifact);
  assert(component.verifiedLicense);
  for (const notice of component.copyrightNotices) {
    assert.doesNotMatch(
      notice,
      /copyright (?:holder|owner|notice|law|laws|license|permission|statement|doctrine|treaty|interest|ownership)|copyright and (?:related|similar) rights|^this software is provided|^noninfringement\b|^\(including copyright notices/iu,
      `${component.name}@${component.versionOrCommit} contains license boilerplate instead of an attributable copyright notice`,
    );
  }
  if (
    component.policyDecision === 'allowed'
    && component.usage !== 'development-only'
    && component.name !== 'node-docker-base'
  ) {
    assert(
      component.licenseTextSha256,
      `allowed distributed component ${component.name}@${component.versionOrCommit} needs a verified license text`,
    );
  }
  if (
    component.policyDecision === 'allowed'
    && component.usage !== 'development-only'
    && component.verifiedLicense.includes('MIT')
  ) {
    assert(
      component.copyrightNotices.length > 0,
      `allowed distributed MIT component ${component.name}@${component.versionOrCommit} needs a copyright notice`,
    );
  }
}

console.log('third-party-license-compliance-test: ok');
