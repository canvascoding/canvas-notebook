#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(rootDir, 'dist-portable-cli');
const packageDir = path.join(outputRoot, 'canvas-notebook-cli');
const archivePath = path.join(outputRoot, 'canvas-notebook-cli.tar.gz');
const checksumPath = path.join(outputRoot, 'canvas-notebook-cli.sha256');
const packageVersion = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8')).version;

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

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

await run('npm', ['run', 'cli:build']);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(packageDir, 'install'), { recursive: true });
await cp(path.join(rootDir, 'dist-cli'), path.join(packageDir, 'dist-cli'), { recursive: true });
await cp(path.join(rootDir, 'install', 'macos.sh'), path.join(packageDir, 'install', 'macos.sh'));
await cp(path.join(rootDir, 'install', 'windows.ps1'), path.join(packageDir, 'install', 'windows.ps1'));
await writeFile(path.join(packageDir, 'VERSION'), `${packageVersion}\n`, 'utf8');
await writeFile(
  path.join(packageDir, 'README.txt'),
  [
    'Canvas Notebook portable server CLI',
    '',
    'Prerequisites:',
    '- Node.js',
    '- Docker Desktop on macOS or Windows',
    '',
    'Remote install:',
    '  macOS:   curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/macos.sh | bash',
    '  Windows: irm https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/windows.ps1 | iex',
    '',
    'Local bundle install:',
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

await run('tar', ['-czf', archivePath, '-C', outputRoot, 'canvas-notebook-cli']);
const archiveDigest = await sha256File(archivePath);
await writeFile(checksumPath, `${archiveDigest}  canvas-notebook-cli.tar.gz\n`, 'utf8');

console.log(`Packaged portable CLI: ${packageDir}`);
console.log(`Created archive: ${archivePath}`);
console.log(`Created checksum: ${checksumPath}`);
