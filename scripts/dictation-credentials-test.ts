import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-dictation-credentials-'));
  const names = ['CANVAS_DATA_ROOT', 'DATA', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'WISPR_API_KEY'] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CANVAS_DATA_ROOT = dataRoot;
    for (const name of names.slice(1)) delete process.env[name];

    const { readScopedEnvState, writeScopedEnvRaw } = await import('../app/lib/integrations/env-config');
    const { resolveDictationCredential, saveDictationCredential, readDictationCredentialStatuses } = await import('../app/lib/dictation/credentials');
    const { readDictationAvailability } = await import('../app/lib/dictation/service');
    const openaiSettings = { enabled: true, provider: 'openai' as const, model: 'whisper-1', language: 'auto' };

    await writeScopedEnvRaw('integrations', 'OPENAI_API_KEY=personal-key\n', { secretScope: 'user', userId: 'admin' });
    assert.deepEqual(await resolveDictationCredential('openai'), { value: null, source: null });
    assert.equal((await readDictationAvailability(openaiSettings)).available, false);

    await writeScopedEnvRaw('agents', 'OPENAI_API_KEY=agent-system-key\n');
    assert.deepEqual(await resolveDictationCredential('openai'), { value: 'agent-system-key', source: 'agents' });
    assert.equal((await readDictationAvailability(openaiSettings)).available, true);

    await writeScopedEnvRaw('integrations', 'OTHER_KEY=preserved\n');
    await saveDictationCredential('openai', 'dictation-system-key');
    assert.deepEqual(await resolveDictationCredential('openai'), { value: 'dictation-system-key', source: 'integrations' });
    const integrations = await readScopedEnvState('integrations');
    assert.equal(integrations.entries.find((entry) => entry.key === 'OTHER_KEY')?.value, 'preserved');

    process.env.GROQ_API_KEY = 'process-groq-key';
    assert.deepEqual(await readDictationCredentialStatuses(), {
      openai: { configured: true, source: 'integrations' },
      groq: { configured: true, source: 'environment' },
      gemini: { configured: false, source: null },
      wispr: { configured: false, source: null },
    });
    for (const [provider, key] of [['gemini', 'GEMINI_API_KEY'], ['wispr', 'WISPR_API_KEY']] as const) {
      await writeScopedEnvRaw('integrations', `${key}=fixture-personal-key\n`, { secretScope: 'user', userId: 'admin' });
      assert.deepEqual(await resolveDictationCredential(provider), { value: null, source: null });
      await saveDictationCredential(provider, `fixture-system-${provider}`);
      assert.deepEqual(await resolveDictationCredential(provider), { value: `fixture-system-${provider}`, source: 'integrations' });
      const state = await readScopedEnvState('integrations');
      assert.equal(state.entries.find(entry => entry.key === 'OPENAI_API_KEY')?.value, 'dictation-system-key');
      assert.equal((await readDictationCredentialStatuses())[provider].configured, true);
    }
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
