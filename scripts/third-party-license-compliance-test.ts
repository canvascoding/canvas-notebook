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
    optional?: boolean;
  }>;
};
const licenseCache = JSON.parse(fs.readFileSync(
  thirdPartyCompliancePaths.licenseCache,
  'utf8',
)) as {
  entries?: Record<string, unknown>;
};
const licensePolicy = JSON.parse(fs.readFileSync(
  thirdPartyCompliancePaths.policy,
  'utf8',
)) as {
  packageOverrides?: Record<string, { licenseTextPath?: string | null }>;
};

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

const httpsPlaceholder = inventory.components.find((component) => (
  component.name === 'https' && component.versionOrCommit === '1.0.0'
));
assert(httpsPlaceholder, 'https@1.0.0 must be inventoried');
assert.equal(httpsPlaceholder.verifiedLicense, 'ISC');
assert.equal(httpsPlaceholder.policyDecision, 'review_required');
assert.equal(httpsPlaceholder.licenseTextRef, null);
assert.equal(httpsPlaceholder.licenseTextSha256, null);
assert.deepEqual(httpsPlaceholder.copyrightNotices, []);
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
assert.equal(isReference.policyDecision, 'review_required');
assert(isReference.licenseTextSha256, 'is-reference must retain the canonical MIT terms');
assert.deepEqual(isReference.copyrightNotices, []);
assert.match(isReference.sourceUrl, /9d2719fbcc2059567203063f1e7b65d7831bfd64/u);
assert.match(isReference.reviewNotes || '', /annotated tag v1\.2\.1/u);

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

for (const name of ['github-from-package', 'minimist', 'webworkify']) {
  const component = inventory.components.find((candidate) => candidate.name === name);
  assert(component, `${name} must be inventoried`);
  assert.equal(
    component.policyDecision,
    'review_required',
    `${name} must not use MIT boilerplate as a substitute for a copyright attribution`,
  );
}

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
  if (component.policyDecision === 'allowed' && component.usage !== 'development-only') {
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

if (inventory.releaseGate.approvalStatus === 'pending') {
  assert.equal(
    inventory.releaseGate.status,
    'blocked',
    'commercial releases must remain blocked while the initial responsible/legal approval is pending',
  );
  assert(
    inventory.releaseGate.blockers.some((blocker) => blocker.name === 'first-commercial-release-approval'),
    'the pending initial approval must remain visible as a release blocker',
  );
}
if (inventory.releaseGate.status === 'blocked') {
  assert(inventory.releaseGate.blockers.length > 0);
}

console.log('third-party-license-compliance-test: ok');
