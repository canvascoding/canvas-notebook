#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const outputArgumentIndex = process.argv.indexOf('--output');
const outputPath = outputArgumentIndex >= 0
  ? process.argv[outputArgumentIndex + 1]
  : '/app/docs/compliance/runtime-components.json';
const baseImageArgumentIndex = process.argv.indexOf('--base-image');
const baseImage = baseImageArgumentIndex >= 0
  ? process.argv[baseImageArgumentIndex + 1]
  : 'unresolved';

function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function commandLines(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function repositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return null;
  return String(raw)
    .replace(/^git\+/u, '')
    .replace(/^git:\/\//u, 'https://')
    .replace(/\.git$/u, '');
}

function packageNoticeFiles(packageDirectory) {
  try {
    return fs.readdirSync(packageDirectory)
      .filter((entry) => /^(?:licen[cs]e|copying|copyright|notice)(?:[._-].*)?$/iu.test(entry))
      .sort()
      .map((entry) => {
        const filePath = path.join(packageDirectory, entry);
        return {
          path: filePath,
          sha256: sha256File(filePath),
        };
      });
  } catch {
    return [];
  }
}

function packageDirectoriesInNodeModules(nodeModulesDirectory) {
  let entries = [];
  try {
    entries = fs.readdirSync(nodeModulesDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const packageDirectories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(nodeModulesDirectory, entry.name);
    if (entry.name.startsWith('@')) {
      let scopedEntries = [];
      try {
        scopedEntries = fs.readdirSync(entryPath, { withFileTypes: true });
      } catch {
        scopedEntries = [];
      }
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory()) {
          packageDirectories.push(path.join(entryPath, scopedEntry.name));
        }
      }
    } else {
      packageDirectories.push(entryPath);
    }
  }
  return packageDirectories;
}

function globalNpmPackages() {
  const queue = packageDirectoriesInNodeModules('/usr/local/lib/node_modules');
  const seen = new Set();
  const components = [];
  while (queue.length) {
    const packageDirectory = queue.shift();
    let realDirectory;
    try {
      realDirectory = fs.realpathSync(packageDirectory);
    } catch {
      continue;
    }
    if (seen.has(realDirectory)) continue;
    seen.add(realDirectory);
    let packageJson;
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(realDirectory, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (packageJson.name && packageJson.version) {
      components.push({
        ecosystem: 'global-npm',
        name: String(packageJson.name),
        version: String(packageJson.version),
        packagePath: realDirectory,
        declaredLicense: packageJson.license ? String(packageJson.license) : null,
        sourceUrl: repositoryUrl(packageJson.repository) || packageJson.homepage || null,
        noticeFiles: packageNoticeFiles(realDirectory),
      });
    }
    queue.push(...packageDirectoriesInNodeModules(path.join(realDirectory, 'node_modules')));
  }
  return components.sort((left, right) => (
    left.name.localeCompare(right.name)
    || left.version.localeCompare(right.version)
    || left.packagePath.localeCompare(right.packagePath)
  ));
}

const dpkgPackages = commandLines(
  'dpkg-query',
  ['-W', '-f=${Package}\t${Version}\t${source:Package}\t${source:Version}\n'],
)
  .map((line) => {
    const [name, version, sourcePackage, sourceVersion] = line.split('\t');
    const noticePath = `/usr/share/doc/${name}/copyright`;
    return {
      ecosystem: 'deb',
      name,
      version,
      sourcePackage: sourcePackage || name,
      sourceVersion: sourceVersion || version,
      noticePath,
      noticeSha256: sha256File(noticePath),
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

const pythonInventoryScript = String.raw`
import hashlib
import importlib.metadata
import json
import os

def sha256_file(file_path):
    try:
        digest = hashlib.sha256()
        with open(file_path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None

packages = []
for distribution in importlib.metadata.distributions():
    metadata = distribution.metadata
    name = metadata.get("Name") or distribution.name
    license_files = []
    for entry in distribution.files or []:
        relative_path = str(entry)
        basename = os.path.basename(relative_path)
        path_parts = [part.lower() for part in relative_path.replace("\\\\", "/").split("/")]
        is_pep639_license = any(part in ("license", "licenses", "licence", "licences") for part in path_parts[:-1])
        if not is_pep639_license and not basename.lower().startswith(("license", "licence", "copying", "copyright", "notice")):
            continue
        absolute_path = os.fspath(distribution.locate_file(entry))
        license_files.append({
            "path": absolute_path,
            "sha256": sha256_file(absolute_path),
        })
    packages.append({
        "ecosystem": "python",
        "name": name,
        "version": distribution.version,
        "metadataPath": os.fspath(getattr(distribution, "_path", distribution.locate_file(""))),
        "licenseExpression": metadata.get("License-Expression"),
        "license": metadata.get("License"),
        "homepage": metadata.get("Home-page") or metadata.get("Project-URL"),
        "installer": distribution.read_text("INSTALLER"),
        "recordPath": os.fspath(distribution.locate_file(
            next((entry for entry in distribution.files or [] if os.path.basename(str(entry)) == "RECORD"), "")
        )),
        "licenseFiles": sorted(license_files, key=lambda value: value["path"]),
    })

print(json.dumps(sorted(packages, key=lambda value: value["name"].lower())))
`;

let pythonPackages = [];
try {
  pythonPackages = JSON.parse(execFileSync(
    'python3',
    ['-c', pythonInventoryScript],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  )).map((component) => {
    let debianPackage = null;
    if (component.metadataPath) {
      const owner = commandLines('dpkg-query', ['-S', component.metadataPath])[0] || '';
      const separatorIndex = owner.indexOf(': ');
      debianPackage = separatorIndex >= 0 ? owner.slice(0, separatorIndex) : null;
    }
    return {
      ...component,
      recordSha256: component.recordPath ? sha256File(component.recordPath) : null,
      managedBy: debianPackage ? 'deb' : 'pip',
      debianPackage,
    };
  });
} catch {
  pythonPackages = commandLines('python3', ['-m', 'pip', 'freeze', '--all'])
    .map((line) => {
      const [name, version] = line.split('==');
      return {
        ecosystem: 'python',
        name,
        version: version || 'unresolved',
        metadataPath: null,
        managedBy: 'pip',
        debianPackage: null,
        licenseExpression: null,
        license: null,
        homepage: null,
        licenseFiles: [],
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

const inventory = {
  schemaVersion: 3,
  generatedBy: 'scripts/capture-runtime-component-inventory.mjs',
  baseImage,
  platform: process.argv.includes('--platform')
    ? process.argv[process.argv.indexOf('--platform') + 1]
    : `${process.platform}/${process.arch}`,
  nativeComponents: [
    {
      ecosystem: 'native',
      name: 'node',
      version: process.version.replace(/^v/u, ''),
      sourceUrl: `https://github.com/nodejs/node/tree/v${process.version.replace(/^v/u, '')}`,
      noticeFiles: packageNoticeFiles('/usr/local'),
    },
  ],
  dpkgPackages,
  pythonPackages,
  globalNpmPackages: globalNpmPackages(),
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(inventory, null, 2) + '\n', 'utf8');
console.log(`Captured ${dpkgPackages.length} dpkg and ${pythonPackages.length} Python runtime packages.`);
