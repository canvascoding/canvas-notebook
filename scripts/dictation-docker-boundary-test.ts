import assert from 'node:assert/strict';

async function main() {
  process.env.CANVAS_RUNTIME_ENV = 'docker';

  const { readLocalDictationRuntimeStatus, startLocalDictationRuntimeInstall } = await import(
    '../app/lib/dictation/runtime-install'
  );
  const { validateDictationSettings, writeDictationSettings } = await import(
    '../app/lib/dictation/settings'
  );
  const { readDictationAvailability, transcribeDictationFile } = await import(
    '../app/lib/dictation/service'
  );

  const localSettings = { enabled: true, provider: 'local', model: 'base', language: 'auto' } as const;
  const cloudSettings = { enabled: true, provider: 'groq', model: 'whisper-large-v3-turbo', language: 'auto' } as const;

  assert.deepEqual(await readLocalDictationRuntimeStatus(), { state: 'disabled' });
  await assert.rejects(startLocalDictationRuntimeInstall(), /unavailable in this Docker release/u);
  await assert.rejects(writeDictationSettings(localSettings), /Choose a cloud provider/u);
  assert.deepEqual(validateDictationSettings(cloudSettings), cloudSettings);
  assert.deepEqual(validateDictationSettings(localSettings), localSettings);

  const availability = await readDictationAvailability(localSettings);
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? '', /unavailable in this Docker release/u);
  await assert.rejects(
    transcribeDictationFile(new File([new Uint8Array([1])], 'sample.wav', { type: 'audio/wav' }), localSettings),
    /not installed on this server/u,
  );

  console.log('dictation-docker-boundary-test: ok');
}

void main();
