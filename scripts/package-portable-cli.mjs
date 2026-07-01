#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(rootDir, 'dist-portable-cli');
const packageDir = path.join(outputRoot, 'canvas-notebook-cli');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: 'inherit', shell: false });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
    child.on('error', reject);
  });
}

await run('npm', ['run', 'cli:build']);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(packageDir, 'install'), { recursive: true });
await cp(path.join(rootDir, 'dist-cli'), path.join(packageDir, 'dist-cli'), { recursive: true });
await cp(path.join(rootDir, 'install', 'macos.sh'), path.join(packageDir, 'install', 'macos.sh'));
await cp(path.join(rootDir, 'install', 'windows.ps1'), path.join(packageDir, 'install', 'windows.ps1'));
await writeFile(
  path.join(packageDir, 'README.txt'),
  [
    'Canvas Notebook portable server CLI',
    '',
    'Prerequisites:',
    '- Node.js',
    '- Docker Desktop on macOS or Windows',
    '',
    'macOS:',
    '  bash install/macos.sh',
    '',
    'Windows PowerShell:',
    '  powershell -ExecutionPolicy Bypass -File .\\install\\windows.ps1',
    '',
    'The installer starts the Docker container at http://localhost:3456.',
    '',
  ].join('\n'),
  'utf8',
);

console.log(`Packaged portable CLI: ${packageDir}`);
