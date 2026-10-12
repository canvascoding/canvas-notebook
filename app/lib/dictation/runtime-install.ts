import 'server-only';

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { DICTATION_MODELS } from '../transcription/config';

const execFileAsync = promisify(execFile);

export type LocalDictationRuntimeStatus = {
  state: 'missing' | 'installing' | 'installed' | 'failed' | 'disabled';
  path?: string;
  message?: string;
  engine?: 'faster-whisper' | 'whisper-cpp';
  installedModels?: string[];
  model?: string;
  phase?: 'downloading' | 'verifying' | 'ready' | 'failed';
  downloadedBytes?: number;
  totalBytes?: number;
  updatedAt?: number;
  modelSizes?: Record<string, number>;
};

export function isolatedScriptArguments(script: string, args: string[]): string[] {
  return ['-I', '-c', "import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name='__main__')", path.dirname(script), script, ...args];
}

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
    const { stdout } = await execFileAsync(python, isolatedScriptArguments(script, ['status', dataRoot, requirements]), {
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
    if (!cpp) {
      const statusScript = path.join(path.dirname(script), 'dictation_host_model.py');
      const { stdout: models } = await execFileAsync(python, isolatedScriptArguments(statusScript, ['status', dataRoot]), { timeout: 5_000, maxBuffer: 4_096 });
      const modelStatus = JSON.parse(models) as LocalDictationRuntimeStatus;
      // Runtime installation and model installation are separate operations on hosts.
      Object.assign(result, { installedModels: modelStatus.installedModels,
        model: modelStatus.model, phase: modelStatus.phase,
        downloadedBytes: modelStatus.downloadedBytes, totalBytes: modelStatus.totalBytes, updatedAt: modelStatus.updatedAt });
    }
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
  const child = spawn(python, isolatedScriptArguments(script, ['install', dataRoot, requirements, ...(cpp ? [model] : [])]), {
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

const hostDownloadsKey = Symbol.for('canvas.dictation.host-model-downloads');
const globals = globalThis as typeof globalThis & { [hostDownloadsKey]?: Map<string, Promise<void>> };
const hostDownloads = globals[hostDownloadsKey] ??= new Map();

/** Downloads run outside the worker's transcription timeout and survive caller detachment. */
export async function ensureHostDictationModel(model: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!DICTATION_MODELS.local.includes(model)) throw new Error('Choose a supported local model.');
  const status = await readLocalDictationRuntimeStatus();
  if (status.engine === 'whisper-cpp' || status.installedModels?.includes(model)) return;
  if (status.state !== 'installed') throw new Error('Install the local runtime in Settings first.');
  const { python, script, dataRoot } = runtimeCommand();
  const identity = `${dataRoot}:${model}`;
  let download = hostDownloads.get(identity);
  if (!download) {
    download = execFileAsync(python, isolatedScriptArguments(path.join(path.dirname(script), 'dictation_host_model.py'), ['install', dataRoot, model]), {
      timeout: 20 * 60_000, killSignal: 'SIGKILL', maxBuffer: 4_096,
    }).then(() => undefined).catch(() => { throw new Error('The local model download failed. Check network access and free disk space, then retry.'); });
    hostDownloads.set(identity, download);
    void download.finally(() => hostDownloads.delete(identity)).catch(() => undefined);
  }
  let abort: (() => void) | undefined;
  try {
    if (!signal) return await download;
    await Promise.race([download, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new DOMException('Model preparation was cancelled.', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort && signal) signal.removeEventListener('abort', abort); }
}
