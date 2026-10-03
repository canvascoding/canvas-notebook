import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-dictation-boundary-'));
  process.env.CANVAS_APP_ROOT = temporary;
  process.env.CANVAS_DATA_ROOT = path.join(temporary, 'data');
  process.env.CANVAS_RUNTIME_ENV = 'docker';
  try {
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

    const native = path.join(temporary, 'native/dictation');
    const docs = path.join(temporary, 'docs/compliance');
    const scripts = path.join(temporary, 'scripts');
    fs.mkdirSync(native, { recursive: true });
    fs.mkdirSync(docs, { recursive: true });
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync('scripts/dictation_cpp.py', path.join(scripts, 'dictation_cpp.py'));
    fs.writeFileSync(path.join(native, 'runtime.json'), '{}');
    assert.equal((await readLocalDictationRuntimeStatus()).state, 'failed', 'unverified runtime must remain unavailable');

    const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
    const policy = JSON.parse(fs.readFileSync('docs/compliance/dictation-cpp-policy.json', 'utf8'));
    const modelBytes = Buffer.from('reviewed test model');
    policy.models = { base: { size: modelBytes.length, sha256: digest(modelBytes), url: 'https://example.invalid/base' } };
    const policyPath = path.join(docs, 'dictation-cpp-policy.json');
    fs.writeFileSync(policyPath, JSON.stringify(policy));
    fs.writeFileSync(path.join(native, 'whisper-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.copyFileSync(policy.noticePath, path.join(native, 'LICENSE.txt'));
    fs.copyFileSync(policy.modelNoticePath, path.join(native, 'MODEL-LICENSE.txt'));
    fs.writeFileSync(path.join(native, 'runtime.json'), JSON.stringify({
      schemaVersion: 1, engine: 'whisper-cpp', version: policy.version,
      policySha256: digest(fs.readFileSync(policyPath)), sourceSha256: policy.sourceSha256,
      buildOptions: policy.buildOptions,
      files: Object.fromEntries(['whisper-cli', 'LICENSE.txt', 'MODEL-LICENSE.txt'].map((name) => [name, digest(fs.readFileSync(path.join(native, name)))])),
    }));
    const missing = await readLocalDictationRuntimeStatus();
    assert.equal(missing.state, 'missing');
    assert.equal(missing.engine, 'whisper-cpp');
    assert.deepEqual(missing.installedModels, []);
    assert.deepEqual(await writeDictationSettings(localSettings), localSettings, 'local selection must be allowed in a reviewed image');
    assert.equal((await readDictationAvailability(localSettings)).available, false, 'selection alone must not enable a microphone');

    // Activate a downloaded model via the actual helper, with network replaced by a deterministic fixture.
    const result = spawnSync('python3', ['-c', [
      'import sys, json, io',
      'from pathlib import Path',
      'from unittest.mock import patch',
      `sys.path.insert(0, ${JSON.stringify(scripts)})`,
      'import dictation_cpp as runtime',
      `policy, native = runtime.configuration(Path(${JSON.stringify(policyPath)}))`,
      `directory = Path(${JSON.stringify(process.env.CANVAS_DATA_ROOT)}) / 'dictation/whisper-cpp'`,
      "with patch.object(runtime.urllib.request, 'urlopen', return_value=io.BytesIO(b'reviewed test model')):",
      " runtime.install(directory, policy, native, 'base')",
    ].join('\n')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const installed = await readLocalDictationRuntimeStatus();
    assert.equal(installed.state, 'installed');
    assert.deepEqual(installed.installedModels, ['base']);
    assert.equal((await readDictationAvailability(localSettings)).available, true);
    assert.equal((await readDictationAvailability({ ...localSettings, model: 'tiny' })).available, false);
    assert.equal((await startLocalDictationRuntimeInstall('base')).state, 'installed', 'reinstall must reuse a verified model');
    fs.appendFileSync(path.join(native, 'whisper-cli'), 'modified');
    assert.equal((await readLocalDictationRuntimeStatus()).state, 'failed', 'modified executable must disable availability');

    console.log('dictation-docker-boundary-test: ok');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

void main();
