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
    return execFileSync(command, args, { encoding: 'utf8' })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const dpkgPackages = commandLines('dpkg-query', ['-W', '-f=${Package}\t${Version}\n'])
  .map((line) => {
    const [name, version] = line.split('\t');
    const noticePath = `/usr/share/doc/${name}/copyright`;
    return {
      ecosystem: 'deb',
      name,
      version,
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
        basename = os.path.basename(str(entry))
        if not basename.lower().startswith(("license", "licence", "copying", "copyright", "notice")):
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
  schemaVersion: 2,
  generatedBy: 'scripts/capture-runtime-component-inventory.mjs',
  baseImage,
  dpkgPackages,
  pythonPackages,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(inventory, null, 2) + '\n', 'utf8');
console.log(`Captured ${dpkgPackages.length} dpkg and ${pythonPackages.length} Python runtime packages.`);
