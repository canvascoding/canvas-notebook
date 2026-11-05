import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureRepositories, repositoryReleaseFilename, verifyRepositoryLists } from './debian-repository-lock.mjs';

const repositoryLock = JSON.parse(fs.readFileSync(new URL('../docs/compliance/debian-repository-lock.json', import.meta.url), 'utf8'));

// Availability and frozen index metadata only. APT must still authenticate every
// InRelease signature and enforce its validity period during the image build.
export async function preflightRepositories({ lock = repositoryLock, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-debian-preflight-'));
  try {
    fs.mkdirSync(path.join(directory, 'sources.list.d'));
    fs.mkdirSync(path.join(directory, 'apt.conf.d'));
    configureRepositories(lock, directory);
    const outcomes = await Promise.allSettled(lock.repositories.map(async repository => {
      const url = `${repository.uri}/dists/${repository.suite}/InRelease`;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      try {
        assert.equal(response.status, 200, `Debian metadata unavailable: ${url}, HTTP ${response.status}`);
        const finalUrl = new URL(response.url);
        assert(finalUrl.protocol === 'https:' && finalUrl.hostname === 'snapshot.debian.org', 'Metadata must remain on the official HTTPS snapshot service');
        assert(response.body, `Missing Debian metadata body: ${url}`);
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          assert(bytes <= 2 * 1024 * 1024, `Debian metadata exceeds the preflight bound: ${url}`);
          chunks.push(Buffer.from(chunk));
        }
        fs.writeFileSync(path.join(directory, repositoryReleaseFilename(repository)), Buffer.concat(chunks));
        return { suite: repository.suite, bytes };
      } finally {
        if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
      }
    }));
    const failures = outcomes.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Frozen Debian repository metadata could not be fetched');
    verifyRepositoryLists(lock, directory);
    return { passed: true, preflight: 'https-and-locked-index-metadata', repositories: outcomes.map(result => result.value) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { console.log(JSON.stringify(await preflightRepositories())); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
