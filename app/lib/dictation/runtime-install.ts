import 'server-only';

import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';

const execFileAsync = promisify(execFile);

export type LocalDictationRuntimeStatus = {
  state: 'missing' | 'installing' | 'installed' | 'failed';
  path?: string;
  message?: string;
};

function runtimeCommand() {
  const appRoot = process.env.CANVAS_APP_ROOT?.trim() || process.cwd();
  return {
    python: process.env.CANVAS_PYTHON_PATH?.trim() || 'python3',
    script: path.join(appRoot, 'scripts', 'dictation-runtime.py'),
    dataRoot: resolveCanvasDataRoot(),
    requirements: path.join(appRoot, 'requirements', 'dictation-python.txt'),
  };
}

export async function readLocalDictationRuntimeStatus(): Promise<LocalDictationRuntimeStatus> {
  const { python, script, dataRoot, requirements } = runtimeCommand();
  try {
    const { stdout } = await execFileAsync(python, ['-I', script, 'status', dataRoot, requirements], {
      timeout: 10_000,
      maxBuffer: 4_096,
    });
    const result = JSON.parse(stdout) as LocalDictationRuntimeStatus;
    if (!['missing', 'installing', 'installed', 'failed'].includes(result.state)) {
      throw new Error('Invalid local dictation installation status.');
    }
    if (result.state === 'installed' && !result.path) {
      throw new Error('Local dictation installation path is missing.');
    }
    return result;
  } catch {
    return { state: 'failed', message: 'The local Python runtime is unavailable on this server.' };
  }
}

export async function startLocalDictationRuntimeInstall(): Promise<LocalDictationRuntimeStatus> {
  const status = await readLocalDictationRuntimeStatus();
  if (status.state === 'installed' || status.state === 'installing') return status;
  const { python, script, dataRoot, requirements } = runtimeCommand();
  const child = spawn(python, ['-I', script, 'install', dataRoot, requirements], {
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await readLocalDictationRuntimeStatus();
    if (current.state === 'installing' || current.state === 'installed') return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Local dictation installer did not start.');
}
