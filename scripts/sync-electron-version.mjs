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
  const parts = String(rootVersion).split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9]\d*)$/u.test(part))) {
    throw new Error(`Cannot derive an Electron version from release version "${rootVersion}".`);
  }

  const [year, month, day, release] = parts.map(Number);
  if (release > 999) {
    throw new Error(`Electron release sequence must be between 0 and 999, received "${rootVersion}".`);
  }

  // Electron requires SemVer (three numeric components), whereas Canvas uses
  // YYYY.MM.DD.release. Keep every release sequence in the SemVer patch so
  // same-day releases are still detected by electron-updater.
  return `${year}.${month}.${day * 1_000 + release}`;
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
