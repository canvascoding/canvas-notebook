import 'server-only';

import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { transcribeAudio } from '@/app/lib/transcription/service';
import { DICTATION_MODELS } from '@/app/lib/transcription/config';
import { ensureHostDictationModel, readLocalDictationRuntimeStatus, startLocalDictationRuntimeInstall } from './runtime-install';
import type { LocalPreparation } from './preparation-contract';

type StoredJob = LocalPreparation & { identity?: string };
const LEASE_MS = 45_000;
const PREPARATION_TIMEOUT_MS = 20 * 60_000;

function paths() {
  const root = path.join(resolveCanvasDataRoot(), 'dictation');
  return { root, state: path.join(root, 'preparation.json'), lock: path.join(root, 'preparation.lock') };
}

async function readJob(): Promise<StoredJob | null> {
  try { return JSON.parse(await fs.readFile(paths().state, 'utf8')) as StoredJob; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function writeJob(job: StoredJob): Promise<void> {
  const temporary = `${paths().state}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
  await fs.rename(temporary, paths().state);
}

async function modelIdentity(model: string): Promise<string> {
  const status = await readLocalDictationRuntimeStatus();
  if (!status.installedModels?.includes(model) || !status.path) throw new Error('The selected model is not installed.');
  const appRoot = process.env.CANVAS_APP_ROOT?.trim() || process.cwd();
  const hash = createHash('sha256').update(`${status.engine}:${status.path}`);
  if (status.engine === 'whisper-cpp') {
    const policy = await fs.readFile(path.join(appRoot, 'docs/compliance/dictation-cpp-policy.json'));
    const metadata = JSON.parse(policy.toString()) as { models: Record<string, { sha256: string }> };
    hash.update(policy).update(await fs.readFile(path.join(status.path, `${metadata.models[model].sha256}.json`)));
    hash.update(await fs.readFile(path.join(appRoot, 'native/dictation/runtime.json')));
  } else {
    hash.update(await fs.readFile(path.join(appRoot, 'requirements/dictation-python.txt')))
      .update(await fs.readFile(path.join(resolveCanvasDataRoot(), 'dictation/models', model, 'receipt.json')));
  }
  return hash.digest('hex');
}

export async function readLocalPreparation(): Promise<LocalPreparation | null> {
  const job = await readJob();
  if (!job) return null;
  if (job.state === 'running' && Date.now() - job.updatedAt > LEASE_MS) {
    return { ...job, state: 'failed', phase: 'failed', message: 'Model preparation was interrupted. Please retry.' };
  }
  if (job.state === 'running' && ['runtime', 'downloading', 'verifying'].includes(job.phase)) {
    const runtime = await readLocalDictationRuntimeStatus();
    if (runtime.model === job.model && runtime.phase && runtime.phase !== 'ready' && runtime.phase !== 'failed') {
      return { ...job, phase: runtime.phase, downloadedBytes: runtime.downloadedBytes, totalBytes: runtime.totalBytes };
    }
  }
  if (job.state === 'succeeded') {
    try {
      if (job.identity !== await modelIdentity(job.model)) throw new Error('Changed model');
    } catch {
      return { ...job, state: 'failed', phase: 'failed', result: undefined, message: 'The model or runtime changed. Please test it again.' };
    }
  }
  // Internal receipt identity is not part of the browser contract.
  const { identity: _identity, ...publicJob } = job;
  return publicJob;
}

export async function startLocalPreparation(model: string): Promise<LocalPreparation> {
  if (!DICTATION_MODELS.local.includes(model)) throw new Error('Choose a supported local model.');
  const files = paths();
  await fs.mkdir(files.root, { recursive: true, mode: 0o700 });
  try { await fs.mkdir(files.lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const current = await readJob();
    // A newly acquired lock may not yet have a published job.
    const stat = await fs.stat(files.lock);
    if ((!current && Date.now() - stat.mtimeMs < LEASE_MS) || (current && Date.now() - current.updatedAt < LEASE_MS)) {
      if (current?.model === model) return (await readLocalPreparation())!;
      throw new Error('Another model is being prepared. Wait for it to finish.');
    }
    const stale = `${files.lock}.stale-${randomUUID()}`;
    await fs.rename(files.lock, stale);
    await fs.rm(stale, { recursive: true });
    await fs.mkdir(files.lock, { mode: 0o700 });
  }
  const job: StoredJob = { id: randomUUID(), model, state: 'running', phase: 'runtime', startedAt: Date.now(), updatedAt: Date.now() };
  const owner = path.join(files.lock, 'owner');
  try { await fs.writeFile(owner, job.id, { mode: 0o600 }); await writeJob(job); }
  catch (error) { await fs.rm(files.lock, { recursive: true }); throw error; }
  // Serialize heartbeat/phase writes to prevent stale snapshots overwriting results.
  let writes = Promise.resolve();
  const publish = (change: Partial<StoredJob> = {}) => {
    Object.assign(job, change, { updatedAt: Date.now() });
    const snapshot = { ...job };
    writes = writes.then(async () => {
      if (await fs.readFile(owner, 'utf8') !== job.id) throw new Error('Model preparation ownership changed.');
      await writeJob(snapshot);
    });
    return writes;
  };
  const heartbeat = setInterval(() => { void publish().catch(() => undefined); }, 10_000);
  heartbeat.unref();
  const run = async () => {
    const signal = AbortSignal.timeout(PREPARATION_TIMEOUT_MS);
    try {
      let runtime = await readLocalDictationRuntimeStatus();
      if (runtime.state === 'disabled') throw new Error('Local transcription is unavailable on this server.');
      await publish({ engine: runtime.engine });
      if (runtime.engine === 'whisper-cpp' ? !runtime.installedModels?.includes(model) : runtime.state !== 'installed') {
        await startLocalDictationRuntimeInstall(model);
        while (true) {
          signal.throwIfAborted();
          runtime = await readLocalDictationRuntimeStatus();
          if (runtime.engine === 'whisper-cpp' ? runtime.installedModels?.includes(model) : runtime.state === 'installed') break;
          if (runtime.state === 'failed') throw new Error(runtime.message || 'Local model installation failed.');
          await delay(500, undefined, { signal });
        }
      }
      await publish({ phase: 'downloading' });
      await ensureHostDictationModel(model, signal);
      await publish({ phase: 'loading' });
      const identity = await modelIdentity(model);
      const buffer = await fs.readFile(path.join(process.env.CANVAS_APP_ROOT?.trim() || process.cwd(), 'scripts/fixtures/dictation-self-test.wav'));
      await publish({ phase: 'testing' });
      const result = await transcribeAudio({ buffer, filename: 'dictation-self-test.wav', mimeType: 'audio/wav', signal },
        { enabled: false, provider: 'local', model, language: 'en' });
      const normalized = result.text.toLowerCase().replace(/[^a-z\s]/gu, ' ');
      if (!['fellow', 'americans', 'country'].every(word => normalized.split(/\s/u).includes(word))) {
        throw new Error('The test recording was not recognized reliably. Please retry or select another model.');
      }
      if (identity !== await modelIdentity(model)) throw new Error('The model changed during the test. Please retry.');
      await publish({ state: 'succeeded', phase: 'ready', identity,
        result: { text: result.text, durationMs: result.durationMs, checkedAt: Date.now(), language: 'en' } });
    } catch (error) {
      await publish({ state: 'failed', phase: 'failed', message: signal.aborted ? 'Model preparation timed out. Please retry.'
        : error instanceof Error ? error.message.slice(0, 500) : 'Model preparation failed.' });
    } finally {
      clearInterval(heartbeat);
      try { await writes; } finally {
        if (await fs.readFile(owner, 'utf8').catch(() => null) === job.id) await fs.rm(files.lock, { recursive: true, force: true });
      }
    }
  };
  void run().catch(error => { console.error('[Dictation] Model preparation could not save its final state.', error instanceof Error ? error.name : 'UnknownError'); });
  return job;
}
