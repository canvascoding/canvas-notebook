import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const rootPackagePath = path.join(rootDir, 'package.json');
const electronPackagePath = path.join(rootDir, 'electron/package.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function toDesktopVersion(rootVersion) {
  const parts = String(rootVersion)
    .split('.')
    .map(part => Number.parseInt(part, 10))
    .filter(Number.isFinite);

  if (parts.length < 3) {
    throw new Error(`Cannot derive Electron version from root version "${rootVersion}".`);
  }

  return parts.slice(0, 3).join('.');
}

const rootPackage = readJson(rootPackagePath);
const electronPackage = readJson(electronPackagePath);
const build = electronPackage.build && typeof electronPackage.build === 'object' ? electronPackage.build : {};
const nextVersion = toDesktopVersion(rootPackage.version);
const nextBuildVersion = String(rootPackage.version);

let changed = false;

if (electronPackage.version !== nextVersion) {
  electronPackage.version = nextVersion;
  changed = true;
}

if (build.buildVersion !== nextBuildVersion) {
  electronPackage.build = {
    ...build,
    buildVersion: nextBuildVersion,
  };
  changed = true;
}

if (changed) {
  writeJson(electronPackagePath, electronPackage);
  console.log(`Synced Electron version ${nextVersion} (${nextBuildVersion}).`);
} else {
  console.log(`Electron version already synced: ${nextVersion} (${nextBuildVersion}).`);
}

