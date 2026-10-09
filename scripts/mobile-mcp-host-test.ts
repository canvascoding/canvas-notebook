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
  const root = new EventTarget(), document = new EventTarget(), frameWindow = {}, sent: string[] = [];
  const frame = { sandbox: { add: (...flags: string[]) => assert.deepEqual(flags,['allow-scripts','allow-same-origin']) },
    contentWindow: frameWindow, remove: () => undefined, src: '' };
  const channelId=randomUUID(), nonce='n'.repeat(43), origin='https://instance.example';
  Object.assign(root, { document: Object.assign(document,{ createElement:()=>frame, body:{append:()=>undefined} }),
    location:{origin}, crypto:{randomUUID}, setTimeout, clearTimeout,
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
