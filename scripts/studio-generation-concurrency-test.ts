import assert from 'node:assert/strict';

import {
  getStudioGenerationConcurrencyLimit,
  withStudioGenerationConcurrency,
} from '../app/lib/integrations/studio-generation-concurrency';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function assertConcurrencyLimit(
  mediaType: 'image' | 'video' | 'sound',
  expectedLimit: number,
): Promise<void> {
  const gates = Array.from({ length: expectedLimit + 2 }, deferred);
  let active = 0;
  let peak = 0;
  let started = 0;

  const jobs = gates.map((gate) => withStudioGenerationConcurrency(mediaType, async () => {
    active += 1;
    started += 1;
    peak = Math.max(peak, active);
    await gate.promise;
    active -= 1;
  }));

  await waitFor(() => started === expectedLimit, `${mediaType} jobs did not fill the available slots`);
  assert.equal(peak, expectedLimit);
  assert.equal(started, expectedLimit, `${mediaType} limiter started too many jobs`);

  gates[0].resolve();
  await waitFor(() => started === expectedLimit + 1, `${mediaType} limiter did not release the next queued job`);
  assert.equal(peak, expectedLimit);

  for (const gate of gates) gate.resolve();
  await Promise.all(jobs);
  assert.equal(active, 0);
  assert.equal(started, expectedLimit + 2);
}

async function main() {
  process.env.STUDIO_IMAGE_GENERATION_CONCURRENCY = '5';
  process.env.STUDIO_VIDEO_GENERATION_CONCURRENCY = '2';
  process.env.STUDIO_SOUND_GENERATION_CONCURRENCY = '1';

  assert.equal(getStudioGenerationConcurrencyLimit('image'), 5);
  assert.equal(getStudioGenerationConcurrencyLimit('video'), 2);
  assert.equal(getStudioGenerationConcurrencyLimit('sound'), 1);
  await assertConcurrencyLimit('image', 5);
  await assertConcurrencyLimit('video', 2);
  await assertConcurrencyLimit('sound', 1);

  console.log('studio-generation-concurrency-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
