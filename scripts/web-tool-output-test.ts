import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { braveDirectPayload, managedBravePayload, ollamaPayload, longFirstSnippet } from './fixtures/tool-output/search-fixtures';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-web-output-'));
  process.env.DATA = root; process.env.CANVAS_DATA_ROOT = root;
  process.env.INTEGRATIONS_ENV_PATH = path.join(root, 'secrets', 'Canvas-Integrations.env');
  await fs.mkdir(path.dirname(process.env.INTEGRATIONS_ENV_PATH), { recursive: true });
  const modules = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = modules._load;
  const originalFetch = globalThis.fetch;
  let pageRequests = 0;
  const pageText = 'page start '.repeat(1_000) + 'MIDDLE_PAGE_DETAIL' + ' page end'.repeat(1_000);
  modules._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/security/safe-external-fetch') return {
      ...originalLoad(request, parent, isMain) as Record<string, unknown>,
      fetchExternalResourceSafely: async (url: string, options: { maxBytes: number; signal?: AbortSignal }) => {
        assert.equal(options.maxBytes, 4 * 1024 * 1024); pageRequests++;
        return { buffer: Buffer.from(pageText), contentType: 'text/plain', finalUrl: url, statusCode: 200 };
      },
    };
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { createWebSearchTool, createWebFetchTool } = await import('../app/lib/pi/web-tools');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { getToolOutputMetadata } = await import('../app/lib/pi/tool-output-metadata');
    const { readStoredToolOutput } = await import('../app/lib/pi/tool-output-store');
    const { prepareWebToolOutput } = await import('../app/lib/pi/web-output-preparation');
    const context = {
      userId: 'web-user', sessionId: 'web-session', agentId: null, workspaceId: 'web-workspace', workspaceType: 'personal' as const,
      workspaceName: null, organizationId: null, customerId: null, projectId: null, workspaceRoot: path.join(root, 'workspace'),
      workspaceRootRelativePath: null, canWrite: false, canDelete: false, canShare: false, legacy: false,
    };
    const search = createWebSearchTool();
    for (const provider of ['brave', 'managed', 'ollama']) {
      delete process.env.BRAVE_API_KEY; delete process.env.OLLAMA_API_KEY;
      process.env.WEB_SEARCH_PROVIDER = provider === 'ollama' ? 'ollama' : 'brave';
      process.env.CANVAS_MANAGED_SERVICES_ENABLED = provider === 'managed' ? 'true' : 'false';
      process.env.CANVAS_CONTROL_PLANE_URL = 'https://control-plane.fixture.test';
      process.env.CANVAS_INSTANCE_TOKEN = 'fixture-token';
      // Personal scoped keys resolve from process fallback when no managed provider is selected.
      if (provider === 'brave') process.env.BRAVE_API_KEY = 'fixture-brave';
      if (provider === 'ollama') process.env.OLLAMA_API_KEY = 'fixture-ollama';
      await fs.writeFile(process.env.INTEGRATIONS_ENV_PATH!, '', 'utf8');
      globalThis.fetch = async () => new Response(JSON.stringify(provider === 'brave' ? braveDirectPayload : provider === 'ollama' ? ollamaPayload : managedBravePayload));
      const result = await runWithAgentExecutionContext(context, () => search.execute(`search-${provider}`, { query: 'provider output', count: 4, include_content: false }));
      const text = result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
      assert.ok(text.length <= 6_000, `${provider} obeys the shared search budget`);
      assert.match(text, /\[S3\]/, `${provider} retains later sources`);
      const metadata = getToolOutputMetadata(result.details);
      assert.ok(metadata);
      assert.equal(metadata.references.length, 3);
      assert.ok(JSON.parse((await readStoredToolOutput(context, metadata.references[0].reference)).content).snippet === longFirstSnippet.trim(), 'the complete cleaned first snippet remains readable');
      assert.equal(pageRequests, 0, 'include_content=false never requests pages');
    }
    const withPages = await runWithAgentExecutionContext(context, () => search.execute('search-pages', { query: 'with pages', count: 3, include_content: true, max_content_length: 50_000 }));
    assert.ok(withPages.content[0].type === 'text' && withPages.content[0].text.length <= 6_000);
    const pageMetadata = getToolOutputMetadata(withPages.details)!;
    assert.match(JSON.parse((await readStoredToolOutput(context, pageMetadata.references[0].reference)).content).content, /MIDDLE_PAGE_DETAIL/);

    const fetched = await runWithAgentExecutionContext(context, () => createWebFetchTool().execute('fetch-pages', {
      urls: Array.from({ length: 10 }, (_, i) => `https://example.test/${i}`), max_content_length: 50_000, timeout: 900,
    }));
    assert.ok(fetched.content[0].type === 'text');
    assert.ok(fetched.content[0].text.length <= 10_000);
    assert.match(fetched.content[0].text, /\[S10\]/);
    assert.match(fetched.content[0].text, /Status: 200/);

    const future = await prepareWebToolOutput({
      kind: 'search', provider: 'future-dummy', heading: 'Future provider', identity: context, toolCallId: 'future',
      sources: Array.from({ length: 30 }, (_, i) => ({ title: `Future ${i} ` + 'title'.repeat(100), url: 'https://example.test/' + 'u'.repeat(3_000), snippet: longFirstSnippet })),
    });
    assert.ok(future.content[0].text.length <= 6_000);
    assert.match(future.content[0].text, /\[S20\]/);
    assert.equal(future.details.toolOutput.omittedCount, 10);
    assert.equal(future.details.toolOutput.shownCount, 20);
    assert.doesNotMatch(future.content[0].text, /https:\/\/example.test\/u/, 'overlong URLs are represented by source references, never clipped hyperlinks');
    const unavailable = await prepareWebToolOutput({ kind: 'pages', provider: 'http', heading: 'No session', identity: null, toolCallId: 'none', sources: [{ title: 'Page', url: 'https://example.test', content: pageText }] });
    assert.ok(unavailable.content[0].text.length <= 10_000);
    assert.equal(unavailable.details.toolOutput.references.length, 0);
    assert.match(unavailable.content[0].text, /unavailable/);
    console.log('web-tool-output-test: ok');
  } finally {
    modules._load = originalLoad; globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
