import fs from 'node:fs';

import {
  generateThirdPartyComplianceArtifacts,
  thirdPartyCompliancePaths,
} from './third-party-license-inventory';

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const release = args.has('--release');
const artifacts = generateThirdPartyComplianceArtifacts();

if (check) {
  const currentInventory = fs.existsSync(thirdPartyCompliancePaths.inventory)
    ? fs.readFileSync(thirdPartyCompliancePaths.inventory, 'utf8')
    : '';
  const currentNotices = fs.existsSync(thirdPartyCompliancePaths.notices)
    ? fs.readFileSync(thirdPartyCompliancePaths.notices, 'utf8')
    : '';
  const stale: string[] = [];
  if (currentInventory !== artifacts.inventoryJson) stale.push('docs/compliance/third-party-components.json');
  if (currentNotices !== artifacts.noticesMarkdown) stale.push('THIRD_PARTY_NOTICES.md');
  if (stale.length) {
    throw new Error(`Third-party compliance artifacts are stale: ${stale.join(', ')}`);
  }
} else {
  fs.mkdirSync(thirdPartyCompliancePaths.inventory.replace(/\/[^/]+$/u, ''), { recursive: true });
  fs.writeFileSync(thirdPartyCompliancePaths.inventory, artifacts.inventoryJson, 'utf8');
  fs.writeFileSync(thirdPartyCompliancePaths.notices, artifacts.noticesMarkdown, 'utf8');
}

if (release && artifacts.inventory.releaseGate.status !== 'approved') {
  const sample = artifacts.inventory.releaseGate.blockers
    .slice(0, 10)
    .map((blocker) => `${blocker.name}@${blocker.versionOrCommit}`)
    .join(', ');
  throw new Error(
    `Commercial release blocked by ${artifacts.inventory.releaseGate.blockers.length} third-party compliance item(s): ${sample}`,
  );
}

console.log(
  `third-party notices: ${artifacts.inventory.summary.totalComponents} components, `
  + `${artifacts.inventory.releaseGate.blockers.length} release blocker(s), `
  + `gate=${artifacts.inventory.releaseGate.status}`,
);
