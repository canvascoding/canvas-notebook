import { mkdir, cp, access, lstat, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const staticSrc = path.join(root, '.next', 'static');
const staticDest = path.join(root, '.next', 'standalone', '.next', 'static');
const publicSrc = path.join(root, 'public');
const publicDest = path.join(root, '.next', 'standalone', 'public');
const envSrc = path.join(root, '.env.local');
const envDest = path.join(root, '.next', 'standalone', '.env.local');

async function safeCopy(src, dest) {
  try {
    await access(src, constants.F_OK);
  } catch {
    return;
  }
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true });
}

async function copyEnvFile() {
  try {
    await access(envSrc, constants.F_OK);
  } catch {
    return;
  }

  try {
    const stat = await lstat(envDest);
    if (stat.isDirectory()) {
      await rm(envDest, { recursive: true, force: true });
    }
  } catch {
    // destination does not exist
  }

  await cp(envSrc, envDest);
}

await safeCopy(staticSrc, staticDest);
await safeCopy(publicSrc, publicDest);
await copyEnvFile();
