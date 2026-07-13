import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-studio-credentials-'));
  const previousEnv = {
    CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT,
    DATA: process.env.DATA,
    INTEGRATIONS_ENV_PATH: process.env.INTEGRATIONS_ENV_PATH,
    AGENTS_ENV_PATH: process.env.AGENTS_ENV_PATH,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    KIE_API_KEY: process.env.KIE_API_KEY,
  };

  try {
    process.env.CANVAS_DATA_ROOT = dataRoot;
    delete process.env.DATA;
    delete process.env.INTEGRATIONS_ENV_PATH;
    delete process.env.AGENTS_ENV_PATH;
    process.env.GEMINI_API_KEY = 'process-gemini';
    process.env.OPENAI_API_KEY = 'process-openai';
    process.env.KIE_API_KEY = 'process-kie';

    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const { resolveStudioProviderCredential } = await import('../app/lib/integrations/studio-provider-credentials');

    await replaceScopedEnvEntries('integrations', [
      { key: 'GEMINI_API_KEY', value: 'central-gemini' },
      { key: 'KIE_API_KEY', value: 'central-kie' },
    ]);
    await replaceScopedEnvEntries('agents', [
      { key: 'OPENAI_API_KEY', value: 'central-openai-from-catalog' },
    ]);
    await replaceScopedEnvEntries('integrations', [
      { key: 'GEMINI_API_KEY', value: 'user-gemini' },
    ], { secretScope: 'user', userId: 'user-a' });

    assert.equal(
      await resolveStudioProviderCredential('gemini', { userId: 'user-a' }),
      'user-gemini',
      'an optional personal key should override the central key',
    );
    assert.equal(
      await resolveStudioProviderCredential('gemini', { userId: 'user-b' }),
      'central-gemini',
      'users without a personal key should use the central administrator key',
    );
    assert.equal(
      await resolveStudioProviderCredential('openai', { userId: 'user-b' }),
      'central-openai-from-catalog',
      'Studio should reuse central OpenAI credentials stored by the AI provider catalog',
    );
    assert.equal(
      await resolveStudioProviderCredential('kie', { userId: 'user-b' }),
      'central-kie',
      'central integration credentials should take precedence over process env',
    );

    await replaceScopedEnvEntries('integrations', [
      { key: 'GEMINI_API_KEY', value: 'central-gemini' },
    ]);
    assert.equal(
      await resolveStudioProviderCredential('kie', { userId: 'user-b' }),
      'process-kie',
      'VM process env should remain a central provisioning fallback',
    );

    delete process.env.KIE_API_KEY;
    assert.equal(
      await resolveStudioProviderCredential('kie', { userId: 'user-b' }),
      null,
      'a missing local credential should be left unresolved for the Control Plane fallback',
    );

    console.log('studio-provider-credentials-test: ok');
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      restoreEnv(name, value);
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
