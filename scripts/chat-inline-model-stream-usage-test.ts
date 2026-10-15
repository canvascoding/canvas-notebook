import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { writeChatInlineModelResponse } from './helpers/chat-inline-model-fixture';

async function main() {
  const { stream } = await import('@earendil-works/pi-ai/api/openai-completions');
  const { normalizeContext } = await import('@earendil-works/pi-ai/utils/transcript');
  const modelId = 'owned-controlled-stream-usage', text = 'Inline context received.';
  const wire = new Map<string, string[]>(), requests: Array<{ route: string; stream: boolean }> = [];
  let legacyUsageChunksRemoved = 0;
  const failures: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      const route = request.url ?? '';
      assert(['/legacy/v1/chat/completions', '/current/v1/chat/completions', '/json/v1/chat/completions'].includes(route));
      const parts: Buffer[] = []; let size = 0;
      for await (const part of request) { size += part.length; assert(size <= 16_384); parts.push(Buffer.from(part)); }
      const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as { model?: unknown; stream?: unknown };
      assert.equal(body.model, modelId); assert.equal(body.stream, route !== '/json/v1/chat/completions');
      requests.push({ route, stream: body.stream === true }); wire.set(route, []);
      // Use the actual fixture writer for both responses. The old baseline differs only by its missing usage chunk.
      const observedResponse = new Proxy(response, { get(target, property) {
        if (property === 'write') return (chunk: string) => {
          assert.equal(typeof chunk, 'string');
          const event = JSON.parse(chunk.slice('data: '.length).trim()) as { usage?: unknown };
          if (route === '/legacy/v1/chat/completions' && event.usage) { legacyUsageChunksRemoved++; return true; }
          wire.get(route)!.push(chunk); return target.write(chunk);
        };
        if (property === 'end') return (chunk: string) => { wire.get(route)!.push(chunk); return target.end(chunk); };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      writeChatInlineModelResponse(observedResponse, { modelId, completionIndex: requests.length, stream: body.stream === true });
    } catch (error) { failures.push(error); response.writeHead(400); response.end('Invalid owned unit request'); }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address() as AddressInfo;
    assert.equal(address.address, '127.0.0.1'); assert(address.port > 0 && address.port !== 3000 && address.port !== 3001);
    const origin = `http://127.0.0.1:${address.port}`;
    const callSdk = async (mode: 'legacy' | 'current'): Promise<AssistantMessage> => {
      const model: Model<'openai-completions'> = { id: modelId, name: modelId, api: 'openai-completions', provider: 'ollama',
        baseUrl: `${origin}/${mode}/v1`, reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192 };
      const events: string[] = [], chunks: Array<{ usage: boolean; choices: number }> = [];
      const output = stream(model, normalizeContext({ messages: [{ role: 'user', content: 'Owned SDK transport probe', timestamp: 1 }] }), {
        apiKey: 'owned-unit-placeholder', signal: AbortSignal.timeout(10_000),
        onProviderStreamEvent: raw => {
          assert(raw && typeof raw === 'object');
          const chunk = raw as { usage?: unknown; choices?: unknown[] };
          chunks.push({ usage: !!chunk.usage, choices: chunk.choices?.length ?? -1 });
        },
      });
      for await (const event of output) events.push(event.type);
      const result = await output.result();
      assert.equal(result.stopReason, 'stop'); assert.equal(result.rawStopReason, 'stop');
      assert.deepEqual(result.content, [{ type: 'text', text }]);
      assert(events.includes('text_delta') && events.includes('text_end')); assert.equal(events.at(-1), 'done'); assert(!events.includes('error'));
      assert.equal(result.model, modelId); assert.equal(result.provider, 'ollama');
      assert.equal(chunks.filter(chunk => chunk.usage).length, mode === 'current' ? 1 : 0);
      if (mode === 'current') assert.deepEqual(chunks.at(-1), { usage: true, choices: 0 });
      return result;
    };
    const legacy = await callSdk('legacy');
    assert.equal(legacy.usage.input, 0); assert.equal(legacy.usage.output, 0); assert.equal(legacy.usage.totalTokens, 0);
    assert.equal(legacyUsageChunksRemoved, 1, 'The baseline must actually omit precisely the controlled usage chunk.');
    const current = await callSdk('current');
    assert.equal(current.usage.input, 1); assert.equal(current.usage.output, 1); assert.equal(current.usage.totalTokens, 2);
    assert.equal(current.usage.cacheRead, 0); assert.equal(current.usage.cacheWrite, 0);
    assert.equal(current.usage.cost.total, 0, 'This remains a controlled, free local transport fixture.');
    for (const mode of ['legacy', 'current']) {
      const frames = wire.get(`/${mode}/v1/chat/completions`)!;
      assert.equal(frames.at(-1), 'data: [DONE]\n\n');
      const chunks = frames.slice(0, -1).map(frame => JSON.parse(frame.slice('data: '.length)) as {
        id: string; model: string; object: string; choices: Array<{ delta: { content?: string }; finish_reason?: string | null }>; usage?: unknown });
      assert.equal(new Set(chunks.map(chunk => chunk.id)).size, 1);
      assert(chunks.every(chunk => chunk.model === modelId && chunk.object === 'chat.completion.chunk'));
      assert.equal(chunks[0].choices[0].delta.content, text); assert.equal(chunks[1].choices[0].finish_reason, 'stop');
      assert.equal(chunks.length, mode === 'current' ? 3 : 2);
      if (mode === 'current') assert.deepEqual(chunks[2].usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    }
    const json = await fetch(`${origin}/json/v1/chat/completions`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelId, stream: false }), signal: AbortSignal.timeout(5000) });
    assert.equal(json.status, 200); assert.match(json.headers.get('content-type') ?? '', /^application\/json/u);
    const nonstream = await json.json() as { choices: Array<{ message: { role: string; content: string }; finish_reason: string }>; usage: unknown };
    assert.deepEqual(nonstream.choices, [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }]);
    assert.deepEqual(nonstream.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    assert.deepEqual(requests, [{ route: '/legacy/v1/chat/completions', stream: true },
      { route: '/current/v1/chat/completions', stream: true }, { route: '/json/v1/chat/completions', stream: false }]);
    assert.deepEqual(failures, []);
    console.log('PASS installed pi-ai OpenAI-Completions SDK over ephemeral localhost HTTP: old missing-usage SSE=0 tokens, actual fixed fixture SSE=1 input+1 output=2 tokens; text/stop/done and usage-only choices[] chunk preserved; nonstream parity. No DB, app server, external API or devices.');
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
