import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const generateCalls: Array<Record<string, unknown>> = [];
  const operationStates = [
    { done: false },
    {
      done: true,
      response: {
        generatedVideos: [
          {
            video: {
              uri: encodeURIComponent('https://generativelanguage.googleapis.com/test-video.mp4'),
            },
          },
        ],
      },
    },
  ];
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') {
      return {};
    }
    if (request === '@google/genai') {
      return {
        GoogleGenAI: class GoogleGenAI {
          models = {
            generateVideos: async (payload: Record<string, unknown>) => {
              generateCalls.push(payload);
              return operationStates[0];
            },
          };

          operations = {
            getVideosOperation: async () => operationStates[1],
          };
        },
        VideoGenerationReferenceType: {
          ASSET: 'ASSET',
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-veo-test-'));
  process.env.CANVAS_DATA_ROOT = tempRoot;
  delete process.env.GEMINI_API_KEY;

  const secretsDir = path.join(tempRoot, 'secrets');
  await fs.mkdir(secretsDir, { recursive: true });
  await fs.writeFile(path.join(secretsDir, 'Canvas-Integrations.env'), 'GEMINI_API_KEY=test-gemini-key\n', 'utf8');

  const { getGeminiApiKeyFromIntegrations } = await import('../app/lib/integrations/env-config');
  const { generateVideo } = await import('../app/lib/integrations/veo-generation-service');

  assert.equal(await getGeminiApiKeyFromIntegrations(), 'test-gemini-key');

  const originalFetch = global.fetch;
  const fetchCalls: string[] = [];
  global.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    fetchCalls.push(url);
    if (url === 'https://generativelanguage.googleapis.com/test-video.mp4?key=test-gemini-key') {
      return new Response(Buffer.from('veo video bytes'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = (((fn: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
    fn(...args);
    return 0;
  }) as unknown) as typeof setTimeout;
  global.clearTimeout = (((_id?: ReturnType<typeof setTimeout>) => {}) as unknown) as typeof clearTimeout;

  const originalDateNow = Date.now;
  let nowValues = [0, 1000, 2000, 3000];
  Date.now = () => nowValues.shift() ?? 3000;

  try {
    const result = await generateVideo(
      {
        prompt: 'A detailed product flythrough',
        model: 'veo-3.1-fast-generate-preview',
        resolution: '720p',
        aspectRatio: '16:9',
        durationSeconds: 6,
        negativePrompt: 'blurry',
        enhancePrompt: true,
        generateAudio: false,
        seed: 42,
      },
      'studio-generation',
    );

    assert.equal(generateCalls.length, 1);
    assert.equal(result.fileSize, Buffer.byteLength('veo video bytes'));
    assert.equal(result.mimeType, 'video/mp4');
    assert.ok(result.path.startsWith('studio-gen-a-detailed-product-flythrough-0-'));
    assert.equal(result.mediaUrl, `/api/studio/media/studio/outputs/${encodeURIComponent(result.path)}`);
    assert.equal(result.metadata.provider, 'gemini');
    assert.equal(result.metadata.model, 'veo-3.1-fast-generate-preview');
    assert.equal(result.metadata.createdBy, 'studio-generation');
    assert.equal(result.metadata.output && typeof result.metadata.output === 'object', true);
    assert.equal(fetchCalls[0], 'https://generativelanguage.googleapis.com/test-video.mp4?key=test-gemini-key');

    const saved = await fs.readFile(path.join(tempRoot, 'studio', 'outputs', result.path));
    assert.equal(saved.toString(), 'veo video bytes');
    await assert.rejects(
      fs.access(path.join(tempRoot, 'workspace', 'veo-studio')),
      /ENOENT/,
    );
    await assert.rejects(
      fs.access(path.join(tempRoot, 'studio', 'outputs', result.path.replace(/\.[^.]+$/, '.json'))),
      /ENOENT/,
    );
  } finally {
    moduleInternals._load = originalLoad;
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    Date.now = originalDateNow;
    delete process.env.CANVAS_DATA_ROOT;
  }

  console.log('veo-generation-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
