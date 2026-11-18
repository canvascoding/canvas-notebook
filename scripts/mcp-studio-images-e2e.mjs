import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { expect } from '@playwright/test';
import { authorizeIngestE2EMcp, requireIngestE2ESuccess, requireIngestE2EJson, requireIngestE2EFailure } from './mcp-file-ingest-e2e-helpers.ts';

export async function startImageProviderFixture() {
  const image = await sharp({ create: { width: 24, height: 16, channels: 3, background: 'orange' } }).png().toBuffer();
  const requests = [];
  const dummy = 'local-studio-image-fixture';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith(':generateContent') && req.headers['x-goog-api-key'] === dummy) {
      requests.push({ route: req.url, json: JSON.parse(body.toString()) });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [
        { inlineData: { mimeType: 'image/png', data: image.toString('base64') } },
      ] } }] }));
    } else if (req.url === '/v1/images/edits' && req.headers.authorization === 'Bearer ' + dummy) {
      const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      requests.push({ route: req.url, form });
      res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }));
    } else {
      res.writeHead(400).end(JSON.stringify({ error: 'Unexpected fixture request' }));
    }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  return { requests, image, environment: {
    GEMINI_API_KEY: dummy, OPENAI_API_KEY: dummy, GOOGLE_GEMINI_BASE_URL: url,
    OPENAI_BASE_URL: url + '/v1', CANVAS_MANAGED_SERVICES_ENABLED: 'false',
  }, close: () => new Promise(resolve => server.close(resolve)) };
}

export async function runStudioImagesE2E({ owner, mcp, workspace, deniedWorkspace, physical, step, baseURL, provider }) {
  const workspaceId = workspace.id;
  const headers = { 'x-canvas-workspace-id': workspaceId };
  const call = async (name, args = {}) => requireIngestE2ESuccess(await mcp.call(name, { workspaceId, ...args }), name);
  async function finished(generationId, expected = 'completed') {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const job = await call('studio_image_result', { generationId });
      if (['completed', 'failed'].includes(job.status)) {
        assert.equal(job.status, expected, job.error || 'Unexpected terminal Studio status');
        return job;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('Studio did not complete the image generation.');
  }
  const ref = 'images/reference.png';
  const reference = await sharp({ create: { width: 19, height: 13, channels: 3, background: 'blue' } }).png().toBuffer();
  const fragment = 'violet lighting from the left';
  const uploadedBytes = await sharp({ create: { width: 17, height: 17, channels: 3, background: 'purple' } }).png().toBuffer();
  let preset, catalog, first, uploaded;
  const libraryIds = {};
  const libraryImages = [];

  await step('discover shared image settings, models and a preset created by Studio', async () => {
    const page = await owner.newPage();
    try {
      await page.goto('/en/settings?tab=mcp', { waitUntil: 'domcontentloaded' });
      for (const name of ['Read Studio image catalog', 'Generate Studio images', 'Retrieve Studio images']) {
        await expect(page.getByRole('switch', { name, exact: true })).toBeChecked({ timeout: 60000 });
      }
    } finally {
      await page.close();
    }
    const listing = (await mcp.rpc('tools/list')).tools;
    const inputs = listing.find(tool => tool.name === 'studio_generate_image').inputSchema.properties;
    for (const field of ['model', 'aspect_ratio', 'image_size', 'product_ids', 'persona_ids', 'style_ids', 'preset_id',
      'source_output_id', 'extra_reference_urls', 'quality', 'output_compression', 'stream', 'partial_images']) assert.ok(inputs[field], field);
    const response = await requireIngestE2EJson(await owner.request.post('/api/studio/presets', { headers,
      data: { name: 'MCP fixture lighting', category: 'product', blocks: [
        { type: 'lighting', label: 'Violet light', promptFragment: fragment },
      ] } }), 'Create Studio preset');
    preset = response.preset;
    for (const [kind, color] of [['product', 'red'], ['persona', 'green'], ['style', 'yellow']]) {
      const endpoint = '/api/studio/' + kind + 's';
      const entry = await requireIngestE2EJson(await owner.request.post(endpoint, { headers, data: { name: 'Fixture ' + kind } }), 'Create ' + kind);
      const bytes = await sharp({ create: { width: 31, height: 15, channels: 3, background: color } }).png().toBuffer();
      await requireIngestE2EJson(await owner.request.post(endpoint + '/' + entry[kind].id + '/images', {
        headers, multipart: { file: { name: kind + '.png', mimeType: 'image/png', buffer: bytes } },
      }), 'Add a Studio library image');
      libraryIds[kind + '_ids'] = [entry[kind].id];
      libraryImages.push(bytes);
    }
    const upload = await requireIngestE2EJson(await owner.request.post('/api/studio/references/upload', { headers,
      multipart: { files: { name: 'uploaded.png', mimeType: 'image/png', buffer: uploadedBytes } },
    }), 'Upload a Studio reference');
    uploaded = upload.files[0];
    catalog = await call('studio_image_catalog');
    assert.ok(catalog.references.some(item => item.path === uploaded.path));
    for (const kind of ['product', 'persona', 'style']) {
      assert.ok(catalog.library[kind + 's'].some(item => item.id === libraryIds[kind + '_ids'][0]));
    }
    assert.ok(catalog.presets.some(p => p.id === preset.id));
    for (const id of ['openai', 'gemini']) assert.ok(catalog.providers.find(p => p.id === id)?.available, id);
    for (const name of ['products', 'personas', 'styles']) assert.ok(Array.isArray(catalog.library[name]));
    await fs.mkdir(path.dirname(physical(ref)), { recursive: true });
    await fs.writeFile(physical(ref), reference);
  });
  await step('generate using a workspace reference, preset and exact Gemini settings; retrieve Studio output', async () => {
    const model = catalog.providers.find(p => p.id === 'gemini').models[0].id;
    const args = { idempotencyKey: 'first', provider: 'gemini', model, prompt: 'Generate a product shot',
      preset_id: preset.id, ...libraryIds, extra_reference_urls: [ref, '/api/studio/references/' + path.basename(uploaded.path)], aspect_ratio: '4:3', image_size: '1K' };
    const generation = await call('studio_generate_image', args);
    first = await finished(generation.generationId);
    assert.equal(first.outputs.length, 1);
    const duplicate = await call('studio_generate_image', args);
    assert.equal(duplicate.generationId, first.generationId);
    assert.equal(provider.requests.length, 1);
    const request = provider.requests[0];
    assert.ok(request.route.includes(model));
    const parts = request.json.contents[0].parts;
    assert.ok(parts.some(p => p.text?.includes(fragment)));
    for (const bytes of [reference, uploadedBytes, ...libraryImages]) assert.ok(parts.some(p => p.inlineData?.data === bytes.toString('base64')));
    assert.ok((await call('studio_image_catalog', { referenceSearch: 'studio' })).references.some(item => item.mediaUrl === first.outputs[0].mediaUrl));
    assert.equal(request.json.generationConfig.imageConfig.aspectRatio, '4:3');
    assert.equal(request.json.generationConfig.imageConfig.imageSize, '1K');
    const original = await owner.request.get(first.outputs[0].mediaUrl, { headers });
    assert.equal(original.status(), 200);
    assert.deepEqual(await original.body(), provider.image);
    const result = await mcp.call('studio_image_result', { workspaceId, generationId: first.generationId, outputId: first.outputs[0].outputId });
    const preview = result.content.find(c => c.type === 'image');
    assert.deepEqual(Buffer.from(preview.data, 'base64'), provider.image);
  });
  await step('edit the previous output with OpenAI and verify multipart bytes and model settings', async () => {
    const model = catalog.providers.find(p => p.id === 'openai').models.at(-1).id;
    const generation = await call('studio_generate_image', { idempotencyKey: 'edit', prompt: 'Change the color', provider: 'openai', model,
      source_output_id: first.outputs[0].outputId, image_size: '1536x1024', quality: 'high', background: 'transparent', output_format: 'png' });
    const edit = await finished(generation.generationId);
    assert.notEqual(edit.outputs[0].outputId, first.outputs[0].outputId);
    assert.equal(provider.requests.length, 2);
    const { route, form } = provider.requests[1];
    assert.equal(route, '/v1/images/edits');
    for (const [key, value] of Object.entries({ model, size: '1536x1024', quality: 'high', background: 'transparent', output_format: 'png' })) assert.equal(form.get(key), value);
    const images = [...form.values()].filter(value => typeof value !== 'string');
    const buffers = await Promise.all(images.map(async image => Buffer.from(await image.arrayBuffer())));
    for (const bytes of [provider.image, ...libraryImages]) assert.ok(buffers.some(buffer => buffer.equals(bytes)));
  });
  await step('reject invalid models, ungranted workspaces, foreign references, and revoked grants', async () => {
    const args = { workspaceId, prompt: 'Rejected request', idempotencyKey: 'denied' };
    for (const patch of [{ workspaceId: deniedWorkspace.id }, { model: 'unknown' }, { extra_reference_urls: [
      '/api/media/' + ref + '?workspaceId=' + deniedWorkspace.id] }]) {
      requireIngestE2EFailure(await mcp.call('studio_generate_image', { ...args, ...patch }));
    }
    requireIngestE2EFailure(await mcp.call('studio_image_result', { workspaceId: deniedWorkspace.id, generationId: first.generationId }));
    const missing = await call('studio_generate_image', { idempotencyKey: 'missing', prompt: 'Edit an unavailable reference', extra_reference_urls: ['images/missing.png'] });
    const failed = await finished(missing.generationId, 'failed');
    assert.ok(failed.error);
    const settings = await requireIngestE2EJson(await owner.request.get('/api/integrations/mcp-server'), 'Get MCP protocol version');
    const reader = await authorizeIngestE2EMcp(owner, baseURL, workspaceId, settings.data.protocolVersion, {
      scopes: ['openid', 'offline_access', 'workspace:list', 'studio:read'],
    });
    requireIngestE2ESuccess(await reader.call('studio_image_result', { workspaceId, generationId: first.generationId }), 'Read with Studio read scope');
    requireIngestE2EFailure(await reader.call('studio_generate_image', args));
    await reader.revoke();
    await mcp.revoke();
    requireIngestE2EFailure(await mcp.call('studio_generate_image', args));
    assert.equal(provider.requests.length, 2);
  });
}
