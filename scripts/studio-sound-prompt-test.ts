import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import { normalizeStudioPrompt } from '../app/lib/integrations/studio-prompt';

async function main() {
  const calls: Array<{ contents: Array<{ parts: Array<{ text?: string }> }> }> = [];
  class FixtureGoogleGenAI {
    models = {
      generateContent: async (payload: typeof calls[number]) => {
        calls.push(payload);
        return { candidates: [{ content: { parts: [
          { inlineData: { data: Buffer.from('fixture audio').toString('base64'), mimeType: 'audio/mpeg' } },
        ] } }] };
      },
    };
  }
  mock.module('@google/genai', { exports: { GoogleGenAI: FixtureGoogleGenAI } });
  mock.module(createRequire(import.meta.url).resolve('@google/genai'), { exports: { GoogleGenAI: FixtureGoogleGenAI } });
  mock.module('@/app/lib/integrations/studio-provider-credentials', { exports: {
    resolveStudioProviderCredential: async () => 'fixture-key',
  } });
  mock.module('@/app/lib/integrations/managed-media-client', { exports: {
    isManagedMediaFallbackAvailable: () => false,
    generateManagedMedia: async () => assert.fail('Managed transport is outside this SDK fixture'),
  } });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Sound prompt tests must not perform network requests.'); };
  try {
    const { generateSound } = await import('../app/lib/integrations/sound-generation-service');
    const prompt = normalizeStudioPrompt('  Strophe ä 🖼️\r\n\r\n\tRuhig beginnen.\rLeise enden.  ');
    assert.equal(prompt, 'Strophe ä 🖼️\n\n\tRuhig beginnen.\nLeise enden.');
    const result = await generateSound({ prompt: prompt!, model: 'lyria-3-clip-preview' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].contents[0].parts[0].text, prompt);
    assert.equal(result.audioBytes.toString(), 'fixture audio');
    console.log('Studio sound prompt reaches the real Lyria SDK adapter unchanged.');
  } finally {
    globalThis.fetch = previousFetch;
    mock.reset();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
