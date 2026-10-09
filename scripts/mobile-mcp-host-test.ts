import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
import type { Transport, JSONRPCMessage, CallToolResult } from '@modelcontextprotocol/client';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { App } from '@modelcontextprotocol/ext-apps';
import { McpAppFrameTransport } from '../app/lib/mcp/apps-browser-transport';

async function load<T>(filename: string, mocks: Record<string, unknown>): Promise<T> {
  const absolute = path.resolve(filename), native = createRequire(absolute), compiled = { exports: {} };
  const source = ts.transpileModule(await fs.readFile(absolute, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function('require','module','exports',source)((name: string) => name in mocks ? mocks[name] : native(name), compiled, compiled.exports);
  return compiled.exports as T;
}
async function sdkHandshake() {
  const make = (): Transport => ({ start: async () => undefined, send: async () => undefined, close: async () => undefined });
  const host = make(), provider = make();
  host.send = async (message: JSONRPCMessage) => { queueMicrotask(() => provider.onmessage?.(message)); };
  provider.send = async (message: JSONRPCMessage) => { queueMicrotask(() => host.onmessage?.(message)); };
  const bridge = new AppBridge(null, { name: 'trusted-mobile-host-test', version: '1' }, { serverTools: {} }, {
    hostContext: { theme: 'dark', platform: 'mobile', containerDimensions: { width: 320, maxHeight: 640 }, deviceCapabilities: { touch: true, hover: false } },
  });
  const app = new App({ name: 'SDK-test-provider', version: '1' }, {}, { autoResize: false });
  let input: unknown, result: unknown, calls = 0;
  app.ontoolinput = params => { input = params.arguments; };
  app.ontoolresult = params => { result = params; };
  bridge.oncalltool = async params => { calls++; assert.equal(params.name,'allowed'); return { content: [], _meta: { transient: true } }; };
  await bridge.connect(host); await app.connect(provider);
  await bridge.sendToolInput({ arguments: { saved: true } }); await bridge.sendToolResult({ content: [], structuredContent: { hydrated: true } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(input, { saved: true }); assert.deepEqual(result, { content: [], structuredContent: { hydrated: true } });
  assert.equal(app.getHostContext()?.platform, 'mobile'); assert.equal((app.getHostContext()?.containerDimensions as { width: number } | undefined)?.width,320);
  assert.equal((await app.callServerTool({ name: 'allowed', arguments: {} }))._meta?.transient,true); assert.equal(calls,1);
  await assert.rejects(app.openLink({url:'https://unadvertised.example'})); assert.equal(calls,1);
  await app.close(); await bridge.close();
}
async function main() {
  await sdkHandshake();
  const instances: MockBridge[] = [];
  const getBridge = () => instances.at(-1);
  const event = (init: { data: unknown; source?: object | null; origin?: string }) => Object.assign(new Event('message'), init);
  class MockBridge {
    transport?: Transport; hostContext: unknown; onerror?: () => void; onrequestteardown?: () => void;
    onsizechange?: (value: { height: number; width: number }) => void; oninitialized?: () => void;
    oncalltool?: (value: {name: string; arguments: Record<string, unknown>}) => Promise<CallToolResult>;
    inputs: unknown[] = []; results: unknown[] = []; received: unknown[] = [];
    constructor(_client: unknown,_info: unknown,readonly capabilities: unknown,options: {hostContext: unknown}) { instances.push(this); this.hostContext = options.hostContext; }
    setHostContext(value: unknown) { this.hostContext = value; }
    async connect(value: Transport) { this.transport=value; value.onmessage=message=>this.received.push(message); await value.start(); }
    async sendToolInput(value: unknown) { this.inputs.push(value); }
    async sendToolResult(value: unknown) { this.results.push(value); }
    async close() { await this.transport?.close(); }
  }
  const hostModule = await load<typeof import('../app/tool-widgets/mobile-mcp-host')>('app/tool-widgets/mobile-mcp-host.ts', {
    '@modelcontextprotocol/ext-apps/app-bridge': { AppBridge: MockBridge }, '../lib/mcp/apps-browser-transport': { McpAppFrameTransport },
  });
  const readinessFixture = () => {
    let now = 0, nextTimer = 0;
    const timers = new Map<number, { at: number; run(): void }>();
    const messages: { at: number; value: { type: string } }[] = [];
    const current = new EventTarget(), currentDocument = new EventTarget(), currentFrameWindow = {};
    const currentFrame = { sandbox: { add: () => undefined }, contentWindow: currentFrameWindow, remove: () => undefined, src: '' };
    const currentChannel = randomUUID(), currentNonce = 'r'.repeat(43);
    Object.assign(current, {
      document: Object.assign(currentDocument, { createElement: () => currentFrame, body: { append: () => undefined } }),
      location: { origin: 'https://instance.example' }, crypto: { randomUUID }, performance: { now: () => now },
      setTimeout: (run: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { at: now + delay, run }); return id; },
      clearTimeout: (id: number | undefined) => { if (id !== undefined) timers.delete(id); },
      ReactNativeWebView: { postMessage: (raw: string) => messages.push({ at: now, value: JSON.parse(raw) }) },
      __CANVAS_MOBILE_MCP_HOST__: { channelId: currentChannel, nonce: currentNonce, frameOrigin: 'https://preview.example',
        frameUrl: 'https://preview.example/__preview/t/mobile-mcp/frame', input: { saved: true }, result: { content: [] } },
    });
    const closeCurrent = hostModule.startMobileMcpHost(current as unknown as Window);
    const advance = (duration: number) => {
      const target = now + duration; let executed = 0;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        assert.ok(++executed <= 100, 'readiness must never schedule an unbounded timer loop');
        now = Math.max(now, due[1].at); timers.delete(due[0]); due[1].run();
      }
      now = target;
    };
    const context = { theme: 'light', containerDimensions: { width: 320, maxHeight: 640 } };
    const dispatch = (type: string, payload: unknown, options: { nonce?: string; channelId?: string; source?: object; origin?: string } = {}) => current.dispatchEvent(event({
      data: JSON.stringify({ version: 1, channelId: options.channelId ?? currentChannel, nonce: options.nonce ?? currentNonce, type, payload }),
      source: options.source ?? null, origin: options.origin ?? '',
    }));
    return { messages, timers, advance, jump: (duration: number) => { now += duration; }, context, dispatch,
      malformed: () => current.dispatchEvent(event({ data: '{invalid' })), frameWindow: currentFrameWindow, close: closeCurrent };
  };
  const readiness = readinessFixture(), beforeReadinessBridge = instances.length;
  assert.equal(readiness.messages.length, 1); assert.equal(readiness.messages[0].value.type, 'host_ready');
  readiness.advance(250);
  assert.equal(readiness.messages.length, 2, 'a lost initial native readiness signal must be retried');
  const invalidReadinessSignals = [
    () => readiness.malformed(),
    () => readiness.dispatch('host_context', { context: readiness.context }, { nonce: 'wrong' }),
    () => readiness.dispatch('host_context', { context: readiness.context }, { channelId: randomUUID() }),
    () => readiness.dispatch('host_context', { context: readiness.context }, { source: readiness.frameWindow }),
    () => readiness.dispatch('host_context', { context: readiness.context }, { origin: 'https://other.example' }),
    () => readiness.dispatch('host_context', { context: { ...readiness.context, theme: 'unsupported' } }),
    () => readiness.dispatch('host_context', { context: { ...readiness.context, containerDimensions: { width: 0, maxHeight: 640 } } }),
    () => readiness.dispatch('tool_result', { requestId: randomUUID(), result: { content: [] } }),
    () => readiness.dispatch('teardown', {}, { nonce: 'wrong' }),
  ];
  for (const invalidSignal of invalidReadinessSignals) {
    const beforeSignal: number = readiness.messages.length; invalidSignal(); readiness.advance(250);
    assert.equal(readiness.messages.length, beforeSignal + 1, 'invalid or unrelated native control must not stop readiness');
    assert.equal(instances.length, beforeReadinessBridge, 'unaccepted contexts never initialize the SDK/provider bridge');
  }
  readiness.dispatch('host_context', { context: readiness.context });
  assert.equal(instances.length, beforeReadinessBridge + 1);
  assert.equal(readiness.timers.size, 1, 'only the existing SDK startup timer remains after valid native context');
  const readinessBridge = getBridge()!;
  readinessBridge.oninitialized!(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(readiness.timers.size, 0, 'context acceptance clears readiness immediately, not just on its next tick');
  const afterValidContext = readiness.messages.length;
  readiness.advance(20_000);
  assert.equal(readiness.messages.length, afterValidContext, 'validated current native context cancels readiness timers');
  assert.equal(readiness.timers.size, 0);
  assert.equal(readinessBridge.inputs.length, 1); assert.equal(readinessBridge.results.length, 1);
  readiness.dispatch('host_context', { context: readiness.context });
  assert.equal(instances.length, beforeReadinessBridge + 1);
  assert.equal(readinessBridge.inputs.length, 1); assert.equal(readinessBridge.results.length, 1, 'context repetition cannot replay saved tool input or result');
  assert.equal(readiness.messages.some(message => message.value.type === 'tool_call'), false, 'readiness retries never dispatch a provider tool action');
  readiness.close(); readiness.advance(20_000); assert.equal(readiness.messages.length, afterValidContext);
  const closedReadiness = readinessFixture(); closedReadiness.close(); assert.equal(closedReadiness.timers.size, 0); closedReadiness.advance(20_000);
  assert.equal(closedReadiness.messages.length, 1); assert.equal(closedReadiness.timers.size, 0, 'teardown clears the waiting readiness timer');
  const exhaustedReadiness = readinessFixture(); exhaustedReadiness.advance(20_000);
  assert.equal(exhaustedReadiness.messages.length, 80, 'readiness retries are capped at 80 actual signals within 20 seconds');
  assert.ok(exhaustedReadiness.messages.every(message => message.value.type === 'host_ready' && message.at < 20_000));
  assert.equal(exhaustedReadiness.timers.size, 0); exhaustedReadiness.advance(60_000); assert.equal(exhaustedReadiness.messages.length, 80); exhaustedReadiness.close();
  const delayedReadiness = readinessFixture(); delayedReadiness.jump(20_000); delayedReadiness.advance(0);
  assert.equal(delayedReadiness.messages.length, 1, 'a throttled timer must not send readiness after its monotonic deadline');
  assert.equal(delayedReadiness.timers.size, 0); delayedReadiness.close();
  console.log('Mobile MCP readiness: lost-first signal retry, nine invalid/unrelated controls, valid-context/close cancellation, 80-attempt/20-second monotonic bounds, and no SDK/tool/result replay passed with controlled timers.');
  instances.length = 0; // All readiness fixtures are closed; keep the original host/security cases isolated.
  const root = new EventTarget(), document = new EventTarget(), frameWindow = {}, sent: string[] = [];
  const frame = { sandbox: { add: (...flags: string[]) => assert.deepEqual(flags,['allow-scripts','allow-same-origin']) },
    contentWindow: frameWindow, remove: () => undefined, src: '' };
  const channelId=randomUUID(), nonce='n'.repeat(43), origin='https://instance.example';
  Object.assign(root, { document: Object.assign(document,{ createElement:()=>frame, body:{append:()=>undefined} }),
    location:{origin}, crypto:{randomUUID}, performance, setTimeout, clearTimeout,
    ReactNativeWebView:{postMessage:(message: string)=>sent.push(message)},
    __CANVAS_MOBILE_MCP_HOST__:{channelId,nonce,frameOrigin:'https://preview.example',frameUrl:'https://preview.example/__preview/t/mobile-mcp/frame',input:{saved:true},result:{content:[],_meta:{onlyApp:true}}} });
  const close=hostModule.startMobileMcpHost(root as unknown as Window);
  assert.equal(JSON.parse(sent[0]).type,'host_ready');
  const dispatch=(type: string,payload: unknown,options: {nonce?:string;source?:object|null;origin?:string}={})=>root.dispatchEvent(event({
    data:JSON.stringify({version:1,channelId,nonce:options.nonce??nonce,type,payload}),source:(options.source ?? null) as never,origin:options.origin??'',
  }));
  const context={theme:'dark',containerDimensions:{width:320,height:640},locale:'de',timeZone:'Europe/Berlin',styles:{variables:{'--color-text-primary':'#fff'},css:{fonts:'url(https://evil.example)'}}};
  dispatch('host_context',{context},{nonce:'wrong'}); assert.equal(getBridge(),undefined);
  dispatch('host_context',{context},{source:frameWindow}); assert.equal(getBridge(),undefined);
  dispatch('host_context',{context}); await new Promise(resolve=>setTimeout(resolve,0));
  const bridge = getBridge()!;
  assert.deepEqual(bridge.capabilities,{serverTools:{}}); assert.equal(frame.src.includes('/mobile-mcp/frame'),true);
  assert.doesNotMatch(JSON.stringify(bridge.hostContext),/evil|fonts/u);
  bridge.oninitialized!(); await new Promise(resolve=>setTimeout(resolve,0)); assert.deepEqual(bridge.inputs,[{arguments:{saved:true}}]);
  assert.deepEqual(bridge.results,[{content:[],_meta:{onlyApp:true}}]); assert.equal(JSON.parse(sent.at(-1)!).type,'app_ready');
  root.dispatchEvent(event({data:{jsonrpc:'2.0',method:'test',params:{}},source:frameWindow as never,origin:'https://evil.example'}));
  assert.equal(bridge.received.length,0);
  root.dispatchEvent(event({data:{jsonrpc:'2.0',method:'test',params:{}},source:frameWindow as never,origin:'https://preview.example'}));
  assert.equal(bridge.received.length,1);
  const action=bridge.oncalltool!({name:'allowed',arguments:{exact:true}}), call=JSON.parse(sent.at(-1)!).payload;
  assert.equal(JSON.parse(sent.at(-1)!).type,'tool_call'); assert.equal(call.tool,'allowed');
  assert.equal((await bridge.oncalltool!({name:'second',arguments:{}})).isError,true);
  dispatch('tool_result',{requestId:call.requestId,result:{content:[],_meta:{transient:true}}},{nonce:'wrong'});
  dispatch('tool_result',{requestId:'wrong',result:{content:[]}});
  dispatch('tool_result',{requestId:call.requestId,result:{content:[],_meta:{transient:true}}}); assert.equal((await action)._meta?.transient,true);
  bridge.onsizechange!({height:99999,width:320}); assert.equal(JSON.parse(sent.at(-1)!).payload.height,900);
  bridge.onrequestteardown!(); assert.equal(JSON.parse(sent.at(-1)!).type,'request_teardown');
  const canceled=bridge.oncalltool!({name:'closed',arguments:{}}); close(); assert.equal((await canceled).isError,true);
  const before=sent.length; dispatch('host_context',{context}); assert.equal(sent.length,before);
  console.log('Mobile MCP host: actual App/AppBridge SDK handshake, mobile dimensions/theme, source/origin/nonce validation, bounded single-call bridge and teardown passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
