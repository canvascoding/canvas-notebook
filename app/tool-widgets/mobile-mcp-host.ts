import { z } from 'zod';
import { AppBridge, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { McpAppFrameTransport } from '../lib/mcp/apps-browser-transport';

type Configuration = { channelId: string; nonce: string; frameOrigin: string; frameUrl: string;
  input: Record<string, unknown>; result: CallToolResult };
type NativeWindow = Window & { __CANVAS_MOBILE_MCP_HOST__?: Configuration;
  ReactNativeWebView?: { postMessage: (message: string) => void } };
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const failed = (code: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: code }] });

/** Native supplies environment data only, never arbitrary CSS or SDK capabilities. */
export function readMobileMcpHostContext(value: unknown): McpUiHostContext | null {
  if (!record(value) || (value.theme !== 'light' && value.theme !== 'dark') || !record(value.containerDimensions)) return null;
  const width = value.containerDimensions.width, height = value.containerDimensions.height ?? value.containerDimensions.maxHeight;
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 1 || width > 4096
    || typeof height !== 'number' || !Number.isFinite(height) || height < 1 || height > 4096) return null;
  const styles: NonNullable<McpUiHostContext['styles']> = { variables: {} as NonNullable<McpUiHostContext['styles']>['variables'] };
  if (record(value.styles) && record(value.styles.variables)) {
    for (const [key, color] of Object.entries(value.styles.variables)) {
      if (/^--color-(?:background|text|border|ring)-(?:primary|secondary|tertiary|inverse|ghost|info|danger|success|warning|disabled)$/u.test(key)
        && typeof color === 'string' && color.length <= 64 && /^(?:#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\)|transparent)$/iu.test(color)) {
        (styles.variables as Record<string, string>)[key] = color;
      }
    }
  }
  const safeAreaInsets = record(value.safeAreaInsets) ? Object.fromEntries(['top','right','bottom','left'].map(key => {
    const inset = (value.safeAreaInsets as Record<string, unknown>)[key];
    return [key, typeof inset === 'number' && Number.isFinite(inset) ? Math.max(0, Math.min(500, inset)) : 0];
  })) as { top: number; right: number; bottom: number; left: number } : { top: 0, right: 0, bottom: 0, left: 0 };
  return { theme: value.theme, styles, platform: 'mobile', displayMode: 'inline', availableDisplayModes: ['inline'],
    deviceCapabilities: { touch: true, hover: false }, safeAreaInsets,
    containerDimensions: { width, maxHeight: Math.max(120, Math.min(900, height)) },
    ...(typeof value.locale === 'string' && value.locale.length <= 64 ? { locale: value.locale } : {}),
    ...(typeof value.timeZone === 'string' && value.timeZone.length <= 100 ? { timeZone: value.timeZone } : {}) };
}
export function startMobileMcpHost(host: NativeWindow = window as NativeWindow): () => void {
  // The standalone trusted host has no unsafe-eval permission. Provider App's
  // jitless setting lives in another realm, so apply it here as well.
  z.config({ jitless: true });
  const initial = host.__CANVAS_MOBILE_MCP_HOST__;
  delete host.__CANVAS_MOBILE_MCP_HOST__;
  if (!initial) return () => undefined;
  const config: Configuration = initial;
  const frame = host.document.createElement('iframe');
  frame.title = 'MCP app'; frame.referrerPolicy = 'no-referrer'; frame.sandbox.add('allow-scripts','allow-same-origin');
  host.document.body.append(frame);
  let active = true, bridge: AppBridge | null = null;
  let pending: { requestId: string; resolve: (result: CallToolResult) => void } | null = null;
  let startupTimer: number | undefined;
  let readinessTimer: number | undefined, readinessAttempts = 0, waitingForContext = true;
  const readinessDeadline = host.performance.now() + 20_000;
  const post = (type: string, payload: unknown) => {
    if (!active) return;
    const json = JSON.stringify({ version: 1, channelId: config.channelId, nonce: config.nonce, type, payload });
    if (utf8Bytes(json) <= 65536) host.ReactNativeWebView?.postMessage(json);
  };
  const close = () => {
    if (!active) return;
    active = false; waitingForContext = false; host.clearTimeout(startupTimer); host.clearTimeout(readinessTimer); readinessTimer = undefined;
    host.removeEventListener('message', receive); host.document.removeEventListener('message', receive as EventListener);
    pending?.resolve(failed('MCP_HOST_CLOSED')); pending = null;
    void bridge?.close().catch(() => undefined); bridge = null; frame.remove();
    config.nonce = ''; config.input = {}; config.result = { content: [] };
  };
  const announceReady = () => {
    readinessTimer = undefined;
    if (!active || !waitingForContext || readinessAttempts >= 80 || host.performance.now() >= readinessDeadline) return;
    readinessAttempts++; post('host_ready', {});
    if (active && waitingForContext && readinessAttempts < 80) readinessTimer = host.setTimeout(announceReady, 250);
  };
  const open = async (context: McpUiHostContext) => {
    if (bridge) { bridge.setHostContext(context); return; }
    if (!frame.contentWindow) return;
    const current = new AppBridge(null, { name: 'Canvas Notebook Mobile', version: '1' }, { serverTools: {} }, { hostContext: context });
    bridge = current;
    startupTimer = host.setTimeout(() => { if (active) post('error', { code: 'MCP_HOST_TIMEOUT' }); }, 20_000);
    current.onerror = () => post('error', { code: 'MCP_HOST_UNAVAILABLE' });
    current.onrequestteardown = () => post('request_teardown', {});
    current.onsizechange = size => {
      if (active && typeof size.height === 'number' && Number.isFinite(size.height)) post('size_changed', {
        height: Math.max(120, Math.min(900, Math.ceil(size.height))),
        ...(typeof size.width === 'number' && Number.isFinite(size.width) ? { width: Math.max(1, Math.min(4096, size.width)) } : {}),
      });
    };
    current.oncalltool = params => {
      if (!active || pending || typeof params.name !== 'string' || !params.name || params.name.length > 256
        || !record(params.arguments ?? {})) return Promise.resolve(failed('MCP_INVALID_REQUEST'));
      const args = params.arguments ?? {};
      if (utf8Bytes(JSON.stringify(args)) > 32768) return Promise.resolve(failed('MCP_INVALID_REQUEST'));
      return new Promise<CallToolResult>(resolve => {
        const requestId = host.crypto.randomUUID();
        pending = { requestId, resolve }; post('tool_call', { requestId, tool: params.name, arguments: args });
      });
    };
    current.oninitialized = () => {
      host.clearTimeout(startupTimer);
      void Promise.resolve(current.sendToolInput({ arguments: config.input }))
        .then(() => active ? current.sendToolResult(config.result) : undefined)
        .then(() => { if (active) post('app_ready', {}); }).catch(() => post('error', { code: 'MCP_HOST_UNAVAILABLE' }));
    };
    try {
      await current.connect(new McpAppFrameTransport(frame.contentWindow, config.frameOrigin, host));
      if (active) frame.src = config.frameUrl;
    } catch { post('error', { code: 'MCP_HOST_UNAVAILABLE' }); }
  };
  function receive(event: MessageEvent) {
    // Native postMessage dispatches at the top document. Provider/relay windows
    // cannot send this control envelope, even on Android's exposed bridge.
    if (!active || (event.source !== null && event.source !== host) || (event.origin && event.origin !== host.location.origin)
      || typeof event.data !== 'string' || utf8Bytes(event.data) > 2 * 1024 * 1024 + 16384) return;
    let envelope: unknown;
    try { envelope = JSON.parse(event.data); } catch { return; }
    if (!record(envelope) || envelope.version !== 1 || envelope.channelId !== config.channelId || envelope.nonce !== config.nonce
      || !record(envelope.payload)) return;
    if (envelope.type === 'teardown') { close(); return; }
    if (envelope.type === 'host_context') {
      if (utf8Bytes(event.data) > 65536) return;
      const context = readMobileMcpHostContext(envelope.payload.context);
      if (context) {
        waitingForContext = false; host.clearTimeout(readinessTimer); readinessTimer = undefined;
        void open(context);
      }
    } else if (envelope.type === 'tool_result' && pending && envelope.payload.requestId === pending.requestId) {
      const parsed = CallToolResultSchema.safeParse(envelope.payload.result);
      if (!parsed.success || utf8Bytes(JSON.stringify(parsed.data)) > 2 * 1024 * 1024) return;
      const current = pending; pending = null; current.resolve(parsed.data);
    }
  }
  host.addEventListener('message', receive); host.document.addEventListener('message', receive as EventListener);
  // Android can deliver the first message before its native listener/navigation proof is ready.
  // Only repeat this idempotent handshake; provider input, result and tool actions are never replayed.
  announceReady();
  return close;
}
if (typeof window !== 'undefined' && (window as NativeWindow).__CANVAS_MOBILE_MCP_HOST__) startMobileMcpHost();
