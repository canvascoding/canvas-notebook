import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Model } from '@earendil-works/pi-ai';
import ts from 'typescript';
import { createChatInlineModelTransport } from './helpers/chat-inline-model-fixture';
import { projectNativePageJourneyCurrentTurn, projectNativeSdkCurrentTurn } from './helpers/chat-extension-native-sdk-proof';
import { nativeSqlTitleTextFingerprint } from './helpers/chat-extension-native-sdk-proof';

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-title-transport-'))); await fs.chmod(root, 0o700);
  // Evaluate only these actual pure declarations, never the IO-owning product module.
  const source = await fs.readFile('app/lib/pi/session-title-generator.ts', 'utf8');
  const tree = ts.createSourceFile('title.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['TITLE_PROMPT_MAX_CHARS', 'TITLE_MAX_TOKENS', 'SESSION_TITLE_SYSTEM_PROMPT']);
  const selected = tree.statements.filter(node => ts.isVariableStatement(node)
    ? node.declarationList.declarations.some(declaration => names.has(declaration.name.getText(tree)))
    : ts.isFunctionDeclaration(node) && ['titlePromptMessage', 'extractFirstUserText'].includes(node.name?.text ?? ''));
  assert.equal(selected.length, 5);
  const code = selected.map(node => node.getText(tree)).join('\n')
    + '\nexport { SESSION_TITLE_SYSTEM_PROMPT, TITLE_MAX_TOKENS, titlePromptMessage, extractFirstUserText };';
  const pure: { exports: { SESSION_TITLE_SYSTEM_PROMPT: string; TITLE_MAX_TOKENS: number;
    titlePromptMessage: (text: string) => { role: 'user'; content: string; timestamp: number };
    extractFirstUserText: (messages: unknown[]) => string } } = { exports: {} as never };
  new Function('module', 'exports', ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS } }).outputText)(pure, pure.exports);
  const { createHash } = await import('node:crypto');
  for (const content of ['  Plain inline [App](integration)  ', [{ type: 'text', text: '  Inline [App](integration)  ' }],
    'x'.repeat(1201), [{ type: 'text', text: `  ${'x'.repeat(1201)}  ` }]]) {
    const first = pure.exports.extractFirstUserText([{ role: 'user', content }]);
    const wrapped = pure.exports.titlePromptMessage(first).content;
    const text = wrapped.slice('<first-user-message>\n'.length, -'\n</first-user-message>'.length);
    const fingerprint = nativeSqlTitleTextFingerprint(content);
    assert.equal(fingerprint.textSha256, createHash('sha256').update(text, 'utf8').digest('hex'));
    assert.equal(fingerprint.textUtf16Length, text.length);
  }
  const nonce = '0123456789abcdef0123456789abcdef', modelId = 'owned-native-title-model';
  const transport = createChatInlineModelTransport({ nonce, modelId, native: true, nativePageJourneys: true });
  const negative = createChatInlineModelTransport({ nonce, modelId, native: true, nativePageJourneys: true });
  let legacyRejected = 0, actualSdkCalls = 0; const wire: Record<string, unknown>[] = [];
  const servers: http.Server[] = [];
  const listen = async (handler: http.RequestListener) => {
    const server = http.createServer(handler); servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address() as AddressInfo; assert.equal(address.address, '127.0.0.1');
    assert(![3000, 3001, 3100, 55433].includes(address.port)); return `http://127.0.0.1:${address.port}`;
  };
  const legacyOrigin = await listen(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.equal(body.model, modelId);
      // Exact old fixture classification; no title exception existed.
      if (!projectNativePageJourneyCurrentTurn(body.messages, nonce)) projectNativeSdkCurrentTurn(body.messages, nonce);
      response.writeHead(500); response.end('Unexpected legacy success');
    } catch { legacyRejected++; response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"Invalid owned model request"}'); }
  });
  const currentOrigin = await listen((request, response) => {
    const pieces: Buffer[] = []; request.on('data', piece => pieces.push(Buffer.from(piece)));
    request.on('end', () => { if (request.method === 'POST') wire.push(JSON.parse(Buffer.concat(pieces).toString('utf8'))); });
    return transport.handler(request, response);
  });
  const negativeOrigin = await listen(negative.handler);
  const allowed = new Set([legacyOrigin, currentOrigin, negativeOrigin]);
  const actualFetch = (await import('undici')).fetch; let blockedExternal = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!allowed.has(url.origin)) { blockedExternal++; throw new Error('Only owned local transport is allowed.'); }
    return await actualFetch(url.href, { ...init, redirect: 'error' } as Parameters<typeof actualFetch>[1]) as unknown as Response;
  };
  let summary: Record<string, unknown> | undefined;
  try {
    const { stream } = await import('@earendil-works/pi-ai/api/openai-completions');
    const { normalizeContext } = await import('@earendil-works/pi-ai/utils/transcript');
    const call = async (origin: string, text: string, title = false) => {
      const model: Model<'openai-completions'> = { id: modelId, name: modelId, api: 'openai-completions', provider: 'ollama',
        baseUrl: `${origin}/v1`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 8192,
        ...(title && text.includes('-android-') ? { compat: { maxTokensField: 'max_tokens' as const, supportsStore: false } } : {}) };
      const firstUserText = pure.exports.extractFirstUserText([{ role: 'user',
        content: text.includes('-ios-') ? [{ type: 'text', text }] : text }]);
      const result = stream(model, normalizeContext({ systemPrompt: title ? pure.exports.SESSION_TITLE_SYSTEM_PROMPT : 'Controlled native user turn',
        messages: [title ? pure.exports.titlePromptMessage(firstUserText) : { role: 'user', content: text, timestamp: 1 }] }),
      { apiKey: 'owned-synthetic-placeholder', maxTokens: title ? pure.exports.TITLE_MAX_TOKENS : 128,
        temperature: title ? 0.2 : 0, signal: AbortSignal.timeout(5000) });
      actualSdkCalls++; return await result.result();
    };
    const journey = (platform: 'ios' | 'android') => `PAGE-NATIVE-${nonce}-${platform}-${platform === 'ios' ? 'github' : 'slack'} connected app [App](owned) ${platform === 'android' ? 'x'.repeat(1300) : ''}`;
    assert.equal((await call(legacyOrigin, journey('ios'), true)).stopReason, 'error'); assert.equal(legacyRejected, 1);
    for (const platform of ['ios', 'android'] as const) {
      for (const prefix of ['NATIVE', 'PLAIN-NATIVE']) assert.equal((await call(currentOrigin, `${prefix}-${nonce}-${platform} owned user`)).stopReason, 'stop');
      assert.equal((await call(currentOrigin, journey(platform))).stopReason, 'stop');
      const titleResult = await call(currentOrigin, journey(platform), true);
      if (titleResult.stopReason !== 'stop') {
        const body = wire.at(-1)!;
        console.error({ titleWireShape: { keys: Object.keys(body), max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens,
          temperature: body.temperature, stream: body.stream, stream_options: body.stream_options,
          roles: (body.messages as Array<{ role: string }>).map(row => row.role) }, rejectCounts: transport.counts().rejectedRequests });
      }
      assert.equal(titleResult.stopReason, 'stop');
    }
    const counts = transport.counts(); assert.equal(counts.completions.length, 6); assert.equal(counts.titleCompletions.length, 2);
    assert.equal(counts.forbiddenRequests, 0); assert(Object.values(counts.rejectedRequests).every(value => value === 0));
    assert.equal(counts.completions.filter(row => row.nativeCurrentTurn).length, 4); assert.equal(counts.completions.filter(row => row.nativePageJourneyTurn).length, 2);
    assert.deepEqual(counts.titleCompletions.map(row => [row.platform, row.toolkit]), [['ios', 'github'], ['android', 'slack']]);
    assert.equal((await call(negativeOrigin, journey('ios'))).stopReason, 'stop');
    const titleBody = wire.find(row => row.max_completion_tokens === 32); assert(titleBody);
    let rejectedCases = 0, invalidCompletionCases = 0;
    const rejectBody = async (mutate: (value: Record<string, unknown>) => void, reason = 'invalid_title') => {
      const body = structuredClone(titleBody); mutate(body);
      const response = await fetch(`${negativeOrigin}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 400); assert.equal((await response.json() as { code: string }).code, reason); rejectedCases++;
      if (reason === 'invalid_completion') invalidCompletionCases++;
    };
    const messages = (body: Record<string, unknown>) => body.messages as Array<{ role: string; content: string }>;
    await rejectBody(body => { messages(body)[0].content += ' additional instructions'; });
    await rejectBody(body => { messages(body)[1].content += '\nextra'; });
    await rejectBody(body => { messages(body)[1].content = messages(body)[1].content.replace(nonce, 'f'.repeat(32)); });
    await rejectBody(body => { messages(body)[1].content = messages(body)[1].content.replace('connected app', 'different app'); });
    await rejectBody(body => { messages(body).push({ role: 'user', content: 'extra user' }); });
    await rejectBody(body => { body.tools = []; });
    await rejectBody(body => { body.max_completion_tokens = 33; });
    await rejectBody(body => { body.max_tokens = 32; });
    await rejectBody(body => { body.store = true; });
    await rejectBody(body => { body.temperature = 0.3; });
    await rejectBody(body => { body.stream_options = { include_usage: false }; });
    await rejectBody(body => { body.messages = null; }, 'invalid_completion');
    await rejectBody(body => { body.messages = [null]; }, 'invalid_completion');
    await rejectBody(body => { messages(body)[1].content = null as unknown as string; });
    await rejectBody(body => { messages(body)[1].role = 'assistant'; });
    await rejectBody(body => { messages(body)[1].content = pure.exports.titlePromptMessage(`NATIVE-${nonce}-ios owned user`).content; });
    assert.equal((await call(negativeOrigin, journey('ios'), true)).stopReason, 'stop');
    await rejectBody(() => {}); // No duplicate title per platform.
    assert.equal((await call(negativeOrigin, journey('android'))).stopReason, 'stop');
    assert.equal((await call(negativeOrigin, journey('android'), true)).stopReason, 'stop');
    await rejectBody(body => { messages(body)[1].content = pure.exports.titlePromptMessage(journey('android')).content; });
    const favicon = await fetch(`${negativeOrigin}/favicon.ico`, { signal: AbortSignal.timeout(5000) }); assert.equal(favicon.status, 405); await favicon.arrayBuffer();
    const malformed = await fetch(`${negativeOrigin}/v1/chat/completions`, { method: 'POST', body: '{', signal: AbortSignal.timeout(5000) });
    assert.equal(malformed.status, 400); await malformed.arrayBuffer();
    const denied = negative.counts(); assert.equal(denied.forbiddenRequests, rejectedCases + 2);
    assert.equal(denied.rejectedRequests.invalid_title, rejectedCases - invalidCompletionCases);
    assert.equal(denied.rejectedRequests.invalid_completion, invalidCompletionCases);
    assert.equal(denied.rejectedRequests.unsupported_route, 1); assert.equal(denied.rejectedRequests.invalid_body, 1);
    summary = { version: 1, classification: 'controlled_native_title_transport', actualInstalledSdk: true, productPurePromptDeclarations: true,
      legacyTitleStatus: 400, correctedTitleStatuses: [200, 200], originalChatCaptures: 4, pageJourneyCaptures: 2, separateTitleCaptures: 2,
      positiveForbiddenRequests: counts.forbiddenRequests, negativeRejectedCases: rejectedCases + 2, negativeReasons: denied.rejectedRequests,
      actualSdkCalls, blockedExternalAttempts: blockedExternal, databaseUsed: false, deviceUsed: false, externalProviderUsed: false };
    await fs.writeFile(path.join(root, 'transport-summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600, flag: 'wx' });
  } finally {
    for (const server of servers) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await fs.writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ ownedListenersClosed: true, externalTransportGuardRetained: true }), { mode: 0o600, flag: 'wx' });
  }
  assert(summary); console.log(JSON.stringify({ status: 'passed', root, ...summary, ownedListenersClosed: true }));
}
void main().catch(error => { console.error({ status: 'failed', errorType: error instanceof Error ? error.name : 'Unknown',
  assertion: error instanceof assert.AssertionError ? error.message : undefined,
  sourceLocation: error instanceof Error ? error.stack?.split('\n').find(line => line.includes('chat-inline-model-native-title-test.ts:'))?.trim() : undefined }); process.exitCode = 1; });
