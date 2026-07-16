#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outputArgumentIndex = process.argv.indexOf('--output');
const outputPath = outputArgumentIndex >= 0
  ? process.argv[outputArgumentIndex + 1]
  : '/app/docs/compliance/runtime-components.json';

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
    return {
      ecosystem: 'deb',
      name,
      version,
      noticePath: `/usr/share/doc/${name}/copyright`,
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

const pythonPackages = commandLines('python3', ['-m', 'pip', 'freeze', '--all'])
  .map((line) => {
    const [name, version] = line.split('==');
    return {
      ecosystem: 'python',
      name,
      version: version || 'unresolved',
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name));

const inventory = {
  schemaVersion: 1,
  generatedBy: 'scripts/capture-runtime-component-inventory.mjs',
  baseImage: 'node:24-bookworm-slim',
  dpkgPackages,
  pythonPackages,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(inventory, null, 2) + '\n', 'utf8');
console.log(`Captured ${dpkgPackages.length} dpkg and ${pythonPackages.length} Python runtime packages.`);
