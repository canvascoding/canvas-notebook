import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  base64ImageData,
  braveDirectPayload,
  braveErrorPayload,
  invalidManagedPayload,
  longFirstSnippet,
  longLaterSnippet,
  longUrl,
  managedBravePayload,
  ollamaPayload,
  unicodeTitle,
  unicodeUrl,
} from './fixtures/tool-output/search-fixtures';

function firstTextPart(message: unknown): string {
  const content = (message as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const first = content[0];
  return first && typeof first === 'object' && 'text' in first && typeof first.text === 'string' ? first.text : '';
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-tool-output-characterization-'));
  const secretsDir = path.join(dataDir, 'secrets');
  const integrationsPath = path.join(secretsDir, 'Canvas-Integrations.env');
  await fs.mkdir(secretsDir, { recursive: true });

  process.env.DATA = dataDir;
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.INTEGRATIONS_ENV_PATH = integrationsPath;
  delete process.env.BRAVE_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.WEB_SEARCH_PROVIDER;
  delete process.env.CANVAS_MANAGED_SERVICES_ENABLED;
  delete process.env.CANVAS_CONTROL_PLANE_URL;
  delete process.env.CANVAS_INSTANCE_TOKEN;

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => request === 'server-only' ? {} : originalLoad(request, parent, isMain);

  const originalFetch = globalThis.fetch;
  try {
    const { formatWebSearchResults, searchWeb } = await import('../app/lib/integrations/brave-search-service');
    const { projectAgentMessageForLoadedContext } = await import('../app/lib/pi/message-projection');

    let fetchCalls = 0;
    globalThis.fetch = async (input, init) => {
      fetchCalls += 1;
      assert.match(String(input), /api\.search\.brave\.com\/res\/v1\/web\/search/);
      assert.equal(new Headers(init?.headers).get('X-Subscription-Token'), 'fixture-brave-key');
      return new Response(JSON.stringify(braveDirectPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await fs.writeFile(integrationsPath, 'BRAVE_API_KEY=fixture-brave-key\n', 'utf8');
    const brave = await searchWeb({ query: 'grüße 東京', count: 4, country: 'de', includeContent: false });
    assert.equal(fetchCalls, 1, 'include_content=false must not fetch result pages');
    assert.equal(brave.provider, 'brave');
    assert.equal(brave.mode, 'local');
    assert.equal(brave.country, 'DE');
    assert.equal(brave.results.length, 3, 'empty Brave URLs are discarded');
    assert.equal(brave.results[0].snippet, longFirstSnippet);
    assert.equal(brave.results[2].snippet, longLaterSnippet);
    assert.equal(brave.results[1].title, unicodeTitle);
    assert.equal(brave.results[1].url, unicodeUrl);
    assert.equal(brave.results[2].url, longUrl);
    assert.equal(brave.results[2].content, undefined);
    assert.equal('description_data' in brave.results[2], false, 'unknown provider fields are not copied into direct results');

    const formattedBrave = formatWebSearchResults(brave);
    const rawToolResult = {
      role: 'toolResult',
      toolCallId: 'fixture-tool-call',
      toolName: 'web_search',
      content: [{ type: 'text', text: formattedBrave }],
      timestamp: Date.now(),
    } as Parameters<typeof projectAgentMessageForLoadedContext>[0];
    const projectedToolResult = projectAgentMessageForLoadedContext(rawToolResult, 'context');
    const rawText = firstTextPart(rawToolResult);
    const projectedText = firstTextPart(projectedToolResult);
    assert.match(rawText, /Later Brave result/);
    assert.match(projectedText, /Later Brave result/, 'bounded search formatting retains later sources');
    assert.ok(projectedText.length <= 6_000);
    assert.doesNotMatch(projectedText, /tool result truncated for loaded chat context/);
    assert.equal(projectAgentMessageForLoadedContext(rawToolResult, 'raw'), rawToolResult);

    process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
    process.env.CANVAS_CONTROL_PLANE_URL = 'https://control-plane.fixture.test/agent';
    process.env.CANVAS_INSTANCE_TOKEN = 'fixture-instance-token';
    await fs.writeFile(integrationsPath, '', 'utf8');
    globalThis.fetch = async (input, init) => {
      fetchCalls += 1;
      assert.equal(String(input), 'https://control-plane.fixture.test/v1/managed/brave/search');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-instance-token');
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, { query: 'managed 東京', count: 3, country: 'US' });
      return new Response(JSON.stringify(managedBravePayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const managed = await searchWeb({ query: 'managed 東京', count: 3, includeContent: false });
    assert.equal(managed.mode, 'managed');
    assert.equal(managed.results[0].snippet, longFirstSnippet);
    assert.equal(managed.results[2].snippet, longLaterSnippet);
    assert.equal(managed.results[1].content, undefined, 'managed fields are validated and include_content=false ignores provider page bodies');
    assert.doesNotMatch(formatWebSearchResults(managed), new RegExp(base64ImageData.slice(0, 40)));
    assert.equal(fetchCalls, 2, 'managed include_content=false must not fetch result pages');

    globalThis.fetch = async (input, init) => {
      fetchCalls += 1;
      assert.equal(String(input), 'https://control-plane.fixture.test/v1/managed/brave/search');
      assert.equal(init?.method, 'POST');
      return new Response(JSON.stringify(invalidManagedPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const invalidManaged = await searchWeb({ query: 'invalid managed' });
    assert.deepEqual(invalidManaged.results, [], 'invalid managed result collections currently become empty');

    process.env.WEB_SEARCH_PROVIDER = 'ollama';
    delete process.env.CANVAS_MANAGED_SERVICES_ENABLED;
    delete process.env.CANVAS_CONTROL_PLANE_URL;
    delete process.env.CANVAS_INSTANCE_TOKEN;
    await fs.writeFile(integrationsPath, 'OLLAMA_API_KEY=fixture-ollama-key\n', 'utf8');
    globalThis.fetch = async (input, init) => {
      fetchCalls += 1;
      assert.equal(String(input), 'https://ollama.com/api/web_search');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-ollama-key');
      assert.deepEqual(JSON.parse(String(init?.body)), { query: 'ollama', max_results: 10 });
      return new Response(JSON.stringify(ollamaPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const ollama = await searchWeb({ query: 'ollama', count: 20, includeContent: false });
    assert.equal(ollama.provider, 'ollama');
    assert.equal(ollama.results.length, 3);
    assert.equal(ollama.results[0].snippet, longFirstSnippet);
    assert.equal(ollama.results[2].snippet, longLaterSnippet);
    assert.equal(ollama.results[1].title, unicodeTitle);
    assert.equal(ollama.results[1].url, unicodeUrl);

    delete process.env.WEB_SEARCH_PROVIDER;
    await fs.writeFile(integrationsPath, 'BRAVE_API_KEY=fixture-brave-key\n', 'utf8');
    globalThis.fetch = async () => new Response(JSON.stringify(braveErrorPayload), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
    await assert.rejects(
      () => searchWeb({ query: 'upstream error' }),
      (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 503,
    );

    console.log('tool-output-characterization-test: ok');
  } finally {
    globalThis.fetch = originalFetch;
    moduleInternals._load = originalLoad;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
