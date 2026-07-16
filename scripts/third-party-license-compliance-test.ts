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
  Object.entries((JSON.parse(fs.readFileSync('package-lock.json', 'utf8')) as {
    packages: Record<string, { version?: string }>;
  }).packages).filter(([packagePath, value]) => packagePath.startsWith('node_modules/') && value.version).length,
);

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

for (const component of inventory.components) {
  assert(component.name);
  assert(component.versionOrCommit);
  assert(component.sourceUrl);
  assert(component.packagePathOrArtifact);
  assert(component.verifiedLicense);
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
