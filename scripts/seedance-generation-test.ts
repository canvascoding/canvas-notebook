import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-seedance-test-'));
  process.env.CANVAS_DATA_ROOT = tempRoot;
  delete process.env.KIE_API_KEY;

  const secretsDir = path.join(tempRoot, 'secrets');
  await fs.mkdir(secretsDir, { recursive: true });
  await fs.writeFile(path.join(secretsDir, 'Canvas-Integrations.env'), 'KIE_API_KEY=test-kie-key\n', 'utf8');

  const { getKieApiKeyFromIntegrations } = await import('../app/lib/integrations/env-config');
  const { generateSeedanceVideo } = await import('../app/lib/integrations/seedance-generation-service');

  assert.equal(await getKieApiKeyFromIntegrations(), 'test-kie-key');

  const calls: Array<{ url: string; init?: RequestInit; body?: unknown }> = [];
  let recordInfoCalls = 0;
  const originalFetch = global.fetch;

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });

    if (url.includes('api.kie.ai') || url.includes('redpandaai.co')) {
      assert.equal((init?.headers as Record<string, string> | undefined)?.Authorization, 'Bearer test-kie-key');
    }

    if (url.includes('/api/file-base64-upload')) {
      assert.match(String(body?.base64Data), /^data:image\/png;base64,/);
      return Response.json({
        success: true,
        code: 200,
        msg: 'File uploaded successfully',
        data: {
          downloadUrl: 'https://tempfile.redpandaai.co/test/start-frame.png',
          fileName: body?.fileName,
          fileSize: 10,
          mimeType: 'image/png',
        },
      });
    }

    if (url.includes('/api/v1/jobs/createTask')) {
      assert.equal(body?.model, 'bytedance/seedance-2');
      assert.equal(body?.input?.prompt, 'A tiny cinematic test\n\n\tKeep the original colors.\nSlow camera.');
      assert.equal(body?.input?.first_frame_url, 'https://tempfile.redpandaai.co/test/start-frame.png');
      assert.equal(body?.input?.resolution, '480p');
      assert.equal(body?.input?.aspect_ratio, '21:9');
      assert.equal(body?.input?.duration, 15);
      assert.equal(body?.input?.generate_audio, false);
      assert.equal(body?.input?.web_search, false);
      assert.equal(body?.input?.nsfw_checker, true);
      return Response.json({ code: 200, msg: 'success', data: { taskId: 'task_bytedance_test' } });
    }

    if (url.includes('/api/v1/jobs/recordInfo')) {
      recordInfoCalls += 1;
      if (recordInfoCalls === 1) {
        return Response.json({
          code: 200,
          msg: 'success',
          data: { taskId: 'task_bytedance_test', state: 'generating' },
        });
      }
      return Response.json({
        code: 200,
        msg: 'success',
        data: {
          taskId: 'task_bytedance_test',
          state: 'success',
          resultJson: JSON.stringify({ resultUrls: ['https://cdn.kie.ai/generated/test.mp4'] }),
          costTime: 1234,
        },
      });
    }

    if (url === 'https://cdn.kie.ai/generated/test.mp4') {
      return new Response(Buffer.from('fake video'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const result = await generateSeedanceVideo({
      prompt: '  A tiny cinematic test\r\n\r\n\tKeep the original colors.\rSlow camera.  ',
      aspectRatio: '21:9',
      resolution: '480p',
      durationSeconds: 15,
      firstFrame: {
        imageBytes: Buffer.from('frame').toString('base64'),
        mimeType: 'image/png',
        fileName: 'start.png',
      },
      generateAudio: false,
      webSearch: false,
      nsfwChecker: true,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(result.fileSize, Buffer.byteLength('fake video'));
    assert.equal(result.metadata.taskId, 'task_bytedance_test');
    assert.equal(result.metadata.resultUrl, 'https://cdn.kie.ai/generated/test.mp4');
    const saved = await fs.readFile(path.join(tempRoot, 'studio', 'outputs', result.path));
    assert.equal(saved.toString(), 'fake video');
    assert.equal(calls.some((call) => call.url.includes('/api/file-base64-upload')), true);
    assert.equal(recordInfoCalls, 2);
    const callsBeforeInvalid = calls.length;
    for (const prompt of ['bad\u0000text', '\u000btext', 'text\u000c', 'p'.repeat(20_001)]) {
      await assert.rejects(generateSeedanceVideo({ prompt }), /invalid control characters or exceeds/);
    }
    assert.equal(calls.length, callsBeforeInvalid, 'Invalid prompts must fail before provider HTTP requests');

    const fixture = { imageBytes: Buffer.from('ref').toString('base64'), mimeType: 'image/png' };
    for (const invalid of [
      { model: 'bytedance/seedance-2-5-draft' }, { model: 'bytedance/seedance-2-fast' },
      { durationSeconds: -1 }, { durationSeconds: 3 }, { durationSeconds: 16 }, { durationSeconds: 5.5 },
      { resolution: '4k' }, { aspectRatio: 'bogus' }, { generateAudio: 'true' },
      { lastFrame: fixture }, { firstFrame: fixture, referenceImages: [fixture] },
      { referenceImages: Array(10).fill(fixture) }, { firstFrame: fixture, webSearch: true },
      { model: 'bytedance/seedance-2-5', durationSeconds: 31 },
      { model: 'bytedance/seedance-2-5', referenceImages: Array(31).fill(fixture) },
      { model: 'bytedance/seedance-2-5', referenceImages: [{ ...fixture, mimeType: 'image/gif' }] },
    ]) {
      await assert.rejects(generateSeedanceVideo({ prompt: 'Invalid request', ...invalid } as Parameters<typeof generateSeedanceVideo>[0]));
    }
    assert.equal(calls.length, callsBeforeInvalid, 'Invalid contracts must not upload, create or poll tasks');
    let uploads25 = 0;
    let create25 = 0;
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes('/api/file-base64-upload')) {
        uploads25++;
        return Response.json({ success: true, data: { downloadUrl: `https://fixture.example/${uploads25}` } });
      }
      if (url.includes('/api/v1/jobs/createTask')) {
        create25++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'bytedance/seedance-2-5');
        assert.equal(body.input.duration, 30);
        assert.equal(body.input.reference_image_urls.length, 30);
        assert.equal(body.input.reference_video_urls.length, 10);
        assert.equal(body.input.reference_audio_urls.length, 10);
        assert.equal(body.input.first_frame_url, undefined);
        return Response.json({ code: 200, data: { taskId: 'seedance25' } });
      }
      if (url.includes('/api/v1/jobs/recordInfo')) return Response.json({ code: 200, data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://fixture.example/result.mp4'] }) } });
      if (url === 'https://fixture.example/result.mp4') return new Response('video25', { headers: { 'content-type': 'video/mp4' } });
      throw new Error(`Unexpected Seedance 2.5 fetch: ${url}`);
    }) as typeof fetch;
    const result25 = await generateSeedanceVideo({
      model: 'bytedance/seedance-2-5', prompt: 'Seedance 2.5 reference test', durationSeconds: 30,
      referenceImages: Array(30).fill(fixture),
      referenceVideos: Array(10).fill({ ...fixture, mimeType: 'video/mp4' }),
      referenceAudios: Array(10).fill({ ...fixture, mimeType: 'audio/mpeg' }),
      pollIntervalMs: 1, timeoutMs: 1000,
    });
    assert.equal(uploads25, 50);
    assert.equal(create25, 1);
    assert.equal(result25.metadata.model, 'bytedance/seedance-2-5');
    assert.equal(result25.metadata.durationSeconds, 30);

    recordInfoCalls = 0;
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes('api.kie.ai') || url.includes('redpandaai.co')) {
        assert.equal((init?.headers as Record<string, string> | undefined)?.Authorization, 'Bearer test-kie-key');
      }
      if (url.includes('/api/v1/jobs/createTask')) {
        return Response.json({ code: 200, msg: 'success', data: { taskId: 'task_failed' } });
      }
      if (url.includes('/api/v1/jobs/recordInfo')) {
        return Response.json({
          code: 200,
          msg: 'success',
          data: { taskId: 'task_failed', state: 'fail', failMsg: 'provider rejected prompt' },
        });
      }
      throw new Error(`Unexpected failure fetch URL: ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      generateSeedanceVideo({
        prompt: 'Another tiny cinematic test',
        pollIntervalMs: 1,
        timeoutMs: 1000,
      }),
      /provider rejected prompt/,
    );
  } finally {
    global.fetch = originalFetch;
    delete process.env.CANVAS_DATA_ROOT;
  }

  console.log('seedance-generation-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
