import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./sync-electron-version.mjs', import.meta.url));

async function syncVersion(version) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'canvas-electron-version-'));
  await mkdir(path.join(directory, 'electron'));
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({ version })}\n`);
  await writeFile(
    path.join(directory, 'electron', 'package.json'),
    `${JSON.stringify({ version: '0.0.0', build: {} })}\n`,
  );

  try {
    execFileSync(process.execPath, [scriptPath], { cwd: directory, stdio: 'pipe' });
    return JSON.parse(await readFile(path.join(directory, 'electron', 'package.json'), 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('preserves the release sequence in the Electron SemVer patch', async () => {
  const firstRelease = await syncVersion('2026.8.27.1');
  const secondRelease = await syncVersion('2026.8.27.2');
  const nextDay = await syncVersion('2026.8.28.1');

  assert.equal(firstRelease.version, '2026.8.27001');
  assert.equal(secondRelease.version, '2026.8.27002');
  assert.equal(nextDay.version, '2026.8.28001');
  assert.equal(secondRelease.build.buildVersion, '2026.8.27.2');
});

test('rejects release versions that cannot produce a unique Electron SemVer', async () => {
  await assert.rejects(() => syncVersion('2026.8.27'));
  await assert.rejects(() => syncVersion('2026.8.27.1000'));
});
