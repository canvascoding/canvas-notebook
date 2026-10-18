import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { projectNativePageJourneyCurrentTurn, projectNativeSdkCurrentTurn, type NativePageJourneyTurn, type NativeSdkCurrentTurn } from './chat-extension-native-sdk-proof';

export type ChatInlineFixtureModel = {
  providerInstallationId: string;
  providerId: 'ollama';
  providerName: string;
  modelId: string;
  modelName: string;
  thinkingLevel: 'off';
  expectedCatalogRevision: number;
};
export type ChatInlineCompletion = { hasSkillSentinel: boolean; hasSkillLocation: boolean; toolCount: number; messageCount: number;
  selectedPackages: Array<{ resourceRef: string; publishedRevisionRef: string; checksum: string }>;
  selectedConnections: Array<{ source: string; providerRef: string }>; nativePlatforms: Array<'ios' | 'android'>;
  nativeCurrentTurn?: NativeSdkCurrentTurn; nativePageJourneyTurn?: NativePageJourneyTurn };
export type ChatInlineModelFixture = {
  model: ChatInlineFixtureModel;
  origin: string;
  counts: () => { catalogReads: number; forbiddenRequests: number; completions: ChatInlineCompletion[] };
  close: () => Promise<void>;
};

/** The controlled provider reports the same explicit fixture usage over JSON and the actual SDK's SSE path. */
export function writeChatInlineModelResponse(response: http.ServerResponse, input: { modelId: string; completionIndex: number; stream: boolean }): void {
  const header = { id: `chatcmpl-${input.completionIndex}`, created: 1, model: input.modelId };
  const content = 'Inline context received.', usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (!input.stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ...header, object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage })); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const event = (choices: object[], extra: object = {}) => response.write(`data: ${JSON.stringify({ ...header,
    object: 'chat.completion.chunk', choices, ...extra })}\n\n`);
  event([{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]);
  event([{ index: 0, delta: {}, finish_reason: 'stop' }]);
  // OpenAI's final usage-only chunk has an empty choices array and precedes [DONE].
  event([], { usage }); response.end('data: [DONE]\n\n');
}

/** Fail before mutation unless this is the runner's actual nonce-owned SQL scope. */
async function requireOwnedChatModelFixture(input: { nonce: string; organizationId: string; actorUserId: string }): Promise<void> {
  assert.match(input.nonce, /^[a-f0-9]{32}$/u);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.CANVAS_PLUGIN_EXTENSION_E2E, '1');
  assert((process.env.CANVAS_CHAT_INLINE_E2E === '1') !== (process.env.CANVAS_CHAT_NATIVE_E2E === '1'),
    'Choose one fixed controlled Web-inline or native acceptance mode.');
  assert.equal(process.env.PLUGIN_EXTENSION_E2E_NONCE, input.nonce);
  assert.equal(process.env.CANVAS_ORGANIZATION_ID, input.organizationId);
  assert.equal(input.organizationId, `agent-settings-browser-${input.nonce}`);
  const url = new URL(process.env.DATABASE_URL ?? '');
  const expectedDatabase = `canvas_plugin_extension_test_${input.nonce}`;
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55433');
  assert.equal(url.pathname, `/${expectedDatabase}`); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const { openDb } = await import('../../app/lib/db');
  const database = await openDb();
  try {
    const actual = await database.get('SELECT current_database() AS database_name') as { database_name: string };
    assert.equal(actual.database_name, expectedDatabase);
    const owner = await database.get('SELECT owner_user_id FROM canvas_organization_settings WHERE organization_id=$1', [input.organizationId]) as { owner_user_id: string } | undefined;
    assert.equal(owner?.owner_user_id, input.actorUserId);
    const actor = await database.get('SELECT role FROM "user" WHERE id=$1', [input.actorUserId]) as { role: string } | undefined;
    assert.equal(actor?.role, 'admin');
  } finally { await database.close(); }
}

/** Controlled model transport for actual UI→WebSocket→SQL→SDK acceptance.
 * This proves transport and context delivery; it is not live LLM/provider evidence.
 * The Stage 3 metadata-only model fixture remains separate and unchanged. */
export async function createChatInlineModelFixture(input: {
  nonce: string; organizationId: string; actorUserId: string; nativePageJourneys?: boolean;
}): Promise<ChatInlineModelFixture> {
  await requireOwnedChatModelFixture(input);
  assert(input.nativePageJourneys === undefined || typeof input.nativePageJourneys === 'boolean');
  if (input.nativePageJourneys) assert.equal(process.env.CANVAS_CHAT_NATIVE_E2E, '1');
  const { discoverOllamaModels } = await import('../../app/lib/agent-runtime-policy/ollama-discovery-service');
  const { loadAiCatalogDiscovery } = await import('../../app/lib/agent-runtime-policy/catalog-discovery');
  const { parseAiCatalogUpdate, replaceAiAppRuntimeCatalog } = await import('../../app/lib/agent-runtime-policy/catalog-service');
  const { readAppRuntimeCatalog } = await import('../../app/lib/agent-runtime-policy/catalog-store');
  const { isProviderInstallationCredentialAvailable } = await import('../../app/lib/agent-runtime-policy/installation-credentials');
  const previous = await readAppRuntimeCatalog(input.organizationId);
  assert.equal(previous.providers.length, 0, 'The model fixture may only initialize the isolated runner’s empty catalog.');
  assert.equal(previous.defaultSelection, null);
  const modelId = `agent-extension-${input.nonce.slice(0, 12)}:latest`;
  let catalogReads = 0, forbiddenRequests = 0, closed = false;
  const completions: ChatInlineCompletion[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === `/__owned/${input.nonce}/proof`) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ completions })); return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; assert(size <= 8 * 1024 * 1024); chunks.push(Buffer.from(chunk)); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string; stream?: boolean;
          messages?: Array<{ role: string; content?: unknown }>; tools?: unknown[] };
        assert.equal(body.model, modelId); assert(Array.isArray(body.messages)); assert(completions.length < 30);
        const system = body.messages.filter(row => row.role === 'system' || row.role === 'developer').map(row => JSON.stringify(row.content)).join('\n');
        // Extract only exact public route metadata from the actual SDK system request.
        // Never retain complete prompts, credentials, source contents or generated answers.
        const systemText = body.messages.filter(row => row.role === 'system' || row.role === 'developer')
          .flatMap(row => typeof row.content === 'string' ? [row.content] : Array.isArray(row.content)
            ? row.content.flatMap(block => block && typeof block === 'object' && typeof block.text === 'string' ? [block.text] : []) : []).join('\n');
        const selectedPackages: ChatInlineCompletion['selectedPackages'] = [], selectedConnections: ChatInlineCompletion['selectedConnections'] = [];
        for (const line of systemText.split('\n')) {
          const packageLine = /^P[0-9]+ (\{.*\})$/u.exec(line), connectionLine = /^Connection C[0-9]+: (\{.*\})$/u.exec(line);
          if (packageLine) { const metadata = JSON.parse(packageLine[1]!) as Record<string, unknown>;
            if (typeof metadata.resourceRef === 'string' && typeof metadata.publishedRevisionRef === 'string' && typeof metadata.checksum === 'string')
              selectedPackages.push({ resourceRef: metadata.resourceRef, publishedRevisionRef: metadata.publishedRevisionRef, checksum: metadata.checksum }); }
          if (connectionLine) { const metadata = JSON.parse(connectionLine[1]!) as Record<string, unknown>;
            if (typeof metadata.source === 'string' && typeof metadata.providerRef === 'string') selectedConnections.push({ source: metadata.source, providerRef: metadata.providerRef }); }
        }
        const nativePageJourneyTurn = input.nativePageJourneys ? projectNativePageJourneyCurrentTurn(body.messages, input.nonce) : null;
        const nativeCurrentTurn = process.env.CANVAS_CHAT_NATIVE_E2E === '1' && !nativePageJourneyTurn ? projectNativeSdkCurrentTurn(body.messages, input.nonce) : undefined;
        completions.push({ hasSkillSentinel: system.includes('INLINE_CONTEXT_SENTINEL'), hasSkillLocation: system.includes('SKILL.md'),
          toolCount: body.tools?.length ?? 0, messageCount: body.messages.length, selectedPackages, selectedConnections,
          ...(nativeCurrentTurn ? { nativeCurrentTurn } : {}),
          ...(nativePageJourneyTurn ? { nativePageJourneyTurn } : {}),
          nativePlatforms: (['ios', 'android'] as const).filter(platform => body.messages!.some(message => message.role === 'user'
            && (typeof message.content === 'string' ? [message.content] : Array.isArray(message.content) ? message.content.flatMap(block =>
              block && typeof block === 'object' && typeof block.text === 'string' ? [block.text] : []) : [])
              .some(text => text.startsWith(`NATIVE-${input.nonce}-${platform}`)))) });
        writeChatInlineModelResponse(response, { modelId, completionIndex: completions.length, stream: Boolean(body.stream) }); return;
      } catch { forbiddenRequests++; response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"Invalid owned model request"}'); return; }
    }
    if (request.method !== 'GET' || request.url !== '/api/tags') {
      forbiddenRequests++;
      request.resume(); response.writeHead(405, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unsupported owned chat fixture request.' }));
      return;
    }
    catalogReads++;
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ models: [{ name: modelId, model: modelId,
      modified_at: '2026-10-14T00:00:00Z', size: 1, digest: input.nonce.repeat(2) }] }));
  });
  const close = async () => {
    if (!closed) {
      closed = true;
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
    assert.equal(forbiddenRequests, 0, 'The controlled chat model fixture received an unsupported request.');
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address() as AddressInfo;
    assert.equal(address.address, '127.0.0.1'); assert(address.port !== 3000 && address.port !== 3001);
    const origin = `http://127.0.0.1:${address.port}`;
    const models = await discoverOllamaModels({ serverUrl: origin });
    assert.deepEqual(models.map(model => model.id), [modelId]); assert.equal(catalogReads, 1);
    const config = { ollamaMode: 'local' as const, ollamaHost: origin, ollamaModelSource: 'custom' as const,
      ollamaCustomModel: models[0]!.id, ollamaAdditionalModels: models.map(model => model.id) };
    const discovery = await loadAiCatalogDiscovery({ ollama: [config] });
    assert(discovery.ollama?.models.some(model => model.id === modelId));
    const update = parseAiCatalogUpdate({ expectedRevision: previous.revision, providers: [{ providerId: 'ollama', enabled: true,
      credentialScope: 'organization', config, modelIds: [modelId], defaultModelId: modelId }], defaultSelection: null });
    // Persist through the normal writer first, rather than manufacturing an
    // installation or a verification object for the credential lookup.
    const installed = await replaceAiAppRuntimeCatalog({ organizationId: input.organizationId, actorUserId: input.actorUserId,
      update, discovery, migrationState: 'configured' });
    const installation = installed.providers.find(provider => provider.providerId === 'ollama');
    assert(installation && installation.enabled && installation.status === 'unverified');
    assert(await isProviderInstallationCredentialAvailable({ provider: installation,
      organizationId: input.organizationId, userId: input.actorUserId }), 'The actual local no-auth credential contract must be configured.');
    // Same ready-installation input as legacy bootstrap, derived from the actual
    // stored installation's credential check. This is not model verification.
    await requireOwnedChatModelFixture(input);
    await replaceAiAppRuntimeCatalog({ organizationId: input.organizationId, actorUserId: input.actorUserId,
      update: parseAiCatalogUpdate({ ...update, expectedRevision: installed.revision,
        defaultSelection: input.nativePageJourneys ? { providerInstallationId: installation.installationId, providerId: 'ollama', modelId, thinkingLevel: 'off' } : null }), discovery,
      migrationState: 'configured', readyInstallationIds: new Set([installation.installationId]) });
    const catalog = await readAppRuntimeCatalog(input.organizationId);
    const ready = catalog.providers.find(provider => provider.installationId === installation.installationId);
    assert(ready?.enabled && ready.status === 'ready' && ready.credentialScope === 'organization');
    assert.equal(ready.config.ollamaHost, origin);
    const model = ready.models.find(model => model.enabled && model.id === modelId);
    assert(model && model.thinkingLevels.includes('off')); assert.equal(forbiddenRequests, 0);
    if (input.nativePageJourneys) assert.deepEqual(catalog.defaultSelection, { providerInstallationId: ready.installationId, providerId: 'ollama', modelId, thinkingLevel: 'off' });
    else assert.equal(catalog.defaultSelection, null, 'The fixture provides selectable overrides without changing the application default.');
    return { origin, model: { providerInstallationId: ready.installationId, providerId: 'ollama', providerName: ready.name,
      modelId: model.id, modelName: model.name, thinkingLevel: 'off', expectedCatalogRevision: catalog.revision },
      counts: () => ({ catalogReads, forbiddenRequests, completions: structuredClone(completions) }), close };
  } catch (error) {
    if (server.listening) await close();
    throw error;
  }
}
