import 'server-only';

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';

const execFileAsync = promisify(execFile);

export type LocalDictationRuntimeStatus = {
  state: 'missing' | 'installing' | 'installed' | 'failed' | 'disabled';
  path?: string;
  message?: string;
  engine?: 'faster-whisper' | 'whisper-cpp';
  installedModels?: string[];
};

export function localDictationRuntimeSupported(): boolean {
  return process.env.CANVAS_RUNTIME_ENV !== 'docker'
    || existsSync(path.join(process.env.CANVAS_APP_ROOT?.trim() || process.cwd(), 'native/dictation/runtime.json'));
}

function runtimeCommand() {
  const appRoot = process.env.CANVAS_APP_ROOT?.trim() || process.cwd();
  const cpp = process.env.CANVAS_RUNTIME_ENV === 'docker';
  return {
    python: process.env.CANVAS_PYTHON_PATH?.trim() || 'python3',
    script: path.join(appRoot, 'scripts', cpp ? 'dictation_cpp.py' : 'dictation-runtime.py'),
    dataRoot: resolveCanvasDataRoot(),
    requirements: path.join(appRoot, cpp ? 'docs/compliance/dictation-cpp-policy.json' : 'requirements/dictation-python.txt'),
    cpp,
  };
}

export async function readLocalDictationRuntimeStatus(): Promise<LocalDictationRuntimeStatus> {
  if (!localDictationRuntimeSupported()) return { state: 'disabled' };
  const { python, script, dataRoot, requirements, cpp } = runtimeCommand();
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
    if (cpp && (!Array.isArray(result.installedModels) || !result.installedModels.every((model) => typeof model === 'string'))) {
      throw new Error('Invalid installed dictation models.');
    }
    result.engine = cpp ? 'whisper-cpp' : 'faster-whisper';
    return result;
  } catch {
    return { state: 'failed', engine: cpp ? 'whisper-cpp' : 'faster-whisper', message: 'The local dictation runtime is unavailable or failed verification on this server.' };
  }
}

export async function startLocalDictationRuntimeInstall(model = 'base'): Promise<LocalDictationRuntimeStatus> {
  if (!localDictationRuntimeSupported()) {
    throw new Error('Local dictation installation is unavailable in this Docker release.');
  }
  const status = await readLocalDictationRuntimeStatus();
  if (status.state === 'installing' || (status.state === 'installed'
    && (status.engine !== 'whisper-cpp' || status.installedModels?.includes(model)))) return status;
  const { python, script, dataRoot, requirements, cpp } = runtimeCommand();
  const child = spawn(python, ['-I', script, 'install', dataRoot, requirements, ...(cpp ? [model] : [])], {
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await readLocalDictationRuntimeStatus();
    if (current.state === 'installing' || (current.state === 'installed'
      && (current.engine !== 'whisper-cpp' || current.installedModels?.includes(model)))) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Local dictation installer did not start.');
}
