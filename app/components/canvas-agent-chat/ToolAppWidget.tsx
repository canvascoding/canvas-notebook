'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { McpAppFrameTransport } from '@/app/lib/mcp/apps-browser-transport';
import { readMcpReconnectHint, type McpReconnectHint } from '@/app/lib/mcp/connection-health-types';
import { readToolAppHostContext } from '@/app/lib/tool-apps/host-context';
import type { ToolAppInvocation } from '@/app/lib/tool-apps/types';
import { readAutomationAppData, type AutomationAppData } from '@/app/lib/tool-apps/automation-data';
import { McpReconnectNotice } from './McpReconnectNotice';
import { Button } from '@/components/ui/button';

type Approval = { tool: string; arguments: Record<string, unknown>; resolve: (result: CallToolResult) => void };
type Frame = { url: string; origin: string; result?: CallToolResult };
type Props = {
  invocation: ToolAppInvocation; sessionId: string; agentId: string;
  actions?: (data: AutomationAppData, update: (data: AutomationAppData) => void) => ReactNode;
};
const failedResult = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** One bridge lifecycle for Canvas resources and external MCP Apps. */
export function ToolAppWidget({ invocation, sessionId, agentId, actions }: Props) {
  const t = useTranslations(invocation.kind === 'builtin' ? 'chat.toolApp' : 'chat.mcpApp');
  const locale = useLocale();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const approvalRef = useRef<Approval | null>(null);
  const activeCallRef = useRef<AbortController | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [busy, setBusy] = useState(false);
  const [height, setHeight] = useState(240);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<'unavailable' | 'disabled' | null>(null);
  const [callFailed, setCallFailed] = useState(false);
  const [reconnect, setReconnect] = useState<McpReconnectHint | null>(null);
  const [reload, setReload] = useState(0);
  const builtin = invocation.kind === 'builtin';
  const descriptorJson = JSON.stringify(invocation.descriptor);
  const input = invocation.kind === 'mcp' ? invocation.input : undefined;
  const result = invocation.kind === 'mcp' ? invocation.result : frame?.result;
  const payload = useMemo(() => {
    if (builtin && result === undefined) return null;
    try {
      if (JSON.stringify({ input, result }).length > 2 * 1024 * 1024) return null;
      const parsed = CallToolResultSchema.safeParse(result);
      const args = builtin ? {} : input;
      if (!parsed.success || !args || typeof args !== 'object' || Array.isArray(args)) return null;
      return { input: args as Record<string, unknown>, result: parsed.data };
    } catch { return null; }
  }, [builtin, input, result]);
  const payloadUnavailable = !payload && (!builtin || Boolean(frame));

  useEffect(() => {
    if (payloadUnavailable) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt = 0): Promise<void> => {
      try {
        const response = await fetch(builtin ? '/api/chat/tool-apps' : '/api/mcp/apps', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', signal: abort.signal,
          body: JSON.stringify({ action: 'render', app: JSON.parse(descriptorJson), sessionId, agentId }),
        });
        const body = await response.json();
        if (abort.signal.aborted) return;
        // Retry only the read-only, not-yet-persisted binding. Never replay an action.
        if (builtin && response.status === 425 && attempt < 5) {
          timer = setTimeout(() => { void load(attempt + 1); }, 200 * 2 ** attempt); return;
        }
        if (!response.ok || !body.success) {
          setReconnect(readMcpReconnectHint(body)); setError(!builtin && response.status === 404 ? 'disabled' : 'unavailable'); return;
        }
        const url = new URL(body.data.frameUrl);
        if (url.origin !== body.data.frameOrigin || !['http:', 'https:'].includes(url.protocol)
          || (window.location.protocol === 'https:' && url.protocol !== 'https:')
          || !/^\/__preview\/[A-Za-z0-9_-]{43}\/mcp-app\/frame$/u.test(url.pathname)
          || url.search || url.hash || url.username || url.password) throw new Error();
        setFrame({ url: url.href, origin: url.origin, result: builtin ? body.data.result : undefined });
      } catch { if (!abort.signal.aborted) setError('unavailable'); }
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [agentId, builtin, descriptorJson, reload, sessionId, payloadUnavailable]);

  const frameUrl = frame?.url;
  const frameOrigin = frame?.origin;
  const localeRef = useRef(locale);
  useEffect(() => { localeRef.current = locale; bridgeRef.current?.setHostContext(readToolAppHostContext(locale)); }, [locale]);
  useEffect(() => {
    const iframe = frameRef.current;
    if (!frameUrl || !frameOrigin || !iframe?.contentWindow || error) return;
    let active = true;
    let initialized = false;
    const bridge = new AppBridge(null, { name: 'Canvas Notebook', version: '1' }, builtin ? {} : { serverTools: {} }, {
      hostContext: readToolAppHostContext(localeRef.current),
    });
    bridgeRef.current = bridge;
    const timer = window.setTimeout(() => { if (active && !initialized) setError('unavailable'); }, 20_000);
    bridge.onerror = () => { if (active) setError('unavailable'); };
    bridge.onsizechange = ({ height: next }) => {
      if (active && typeof next === 'number' && Number.isFinite(next)) setHeight(Math.max(120, Math.min(900, Math.ceil(next))));
    };
    if (!builtin) bridge.oncalltool = async (params) => {
      if (!active || approvalRef.current || activeCallRef.current) return failedResult('Another approval or tool call is in progress.');
      if (JSON.stringify(params).length > 32_768) return failedResult('Request too large.');
      return new Promise<CallToolResult>((resolve) => {
        const request = { tool: params.name, arguments: params.arguments ?? {}, resolve };
        approvalRef.current = request; setApproval(request);
      });
    };
    bridge.oninitialized = () => { if (active) { initialized = true; window.clearTimeout(timer); setReady(true); } };
    const observer = new MutationObserver(() => { if (active) bridge.setHostContext(readToolAppHostContext(localeRef.current)); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    void bridge.connect(new McpAppFrameTransport(iframe.contentWindow, frameOrigin))
      .then(() => { if (active) iframe.src = frameUrl; }).catch(() => { if (active) setError('unavailable'); });
    return () => {
      active = false; window.clearTimeout(timer); observer.disconnect();
      bridgeRef.current = null; setReady(false);
      approvalRef.current?.resolve(failedResult('The widget was closed.')); approvalRef.current = null; setApproval(null);
      activeCallRef.current?.abort(); activeCallRef.current = null; setBusy(false);
      void bridge.teardownResource({}, { timeout: 300 }).catch(() => undefined).finally(() => { void bridge.close().catch(() => undefined); });
    };
  }, [frameUrl, frameOrigin, builtin, error]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!ready || !bridge || !payload) return;
    let active = true;
    void Promise.resolve(bridge.sendToolInput({ arguments: payload.input })).then(() => {
      if (active) return bridge.sendToolResult(payload.result);
    }).catch(() => { if (active) setError('unavailable'); });
    return () => { active = false; };
  }, [payload, ready]);

  const decide = async (allow: boolean) => {
    const request = approvalRef.current;
    if (!request || builtin) return;
    approvalRef.current = null; setApproval(null);
    if (!allow) { request.resolve(failedResult('The user rejected this tool call.')); return; }
    const abort = new AbortController(); activeCallRef.current = abort; setBusy(true); setCallFailed(false);
    try {
      const response = await fetch('/api/mcp/apps', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', signal: abort.signal,
        body: JSON.stringify({ action: 'call', app: JSON.parse(descriptorJson), sessionId, agentId, tool: request.tool, arguments: request.arguments }),
      });
      const body = await response.json();
      const parsed = response.ok && body.success ? CallToolResultSchema.safeParse(body.data) : null;
      if (!parsed?.success) {
        if (!abort.signal.aborted) { setReconnect(readMcpReconnectHint(body)); setCallFailed(true); }
        request.resolve(failedResult('Tool call failed. Reconnect or retry manually.'));
      } else request.resolve(parsed.data);
    } catch { request.resolve(failedResult('Tool call failed.')); if (!abort.signal.aborted) setCallFailed(true); }
    finally { if (activeCallRef.current === abort) { activeCallRef.current = null; setBusy(false); } }
  };
  const data = builtin ? readAutomationAppData(payload?.result.structuredContent) : null;
  return <section data-testid={builtin ? 'canvas-tool-app-widget' : 'mcp-app-widget'} className="my-2 w-full max-w-3xl overflow-hidden rounded-[var(--radius)] border bg-background">
    {payloadUnavailable || error ? <div className="space-y-2 p-3 text-xs text-muted-foreground" role="status">
      <p>{t(payloadUnavailable ? 'oversized' : error!)}</p>
      {!payloadUnavailable ? <Button size="xs" variant="outline" onClick={() => {
        setFrame(null); setError(null); setReady(false); setReconnect(null); setCallFailed(false); setReload((n) => n + 1);
      }}>{t('reload')}</Button> : null}
    </div> : <>
      {!ready ? <p className="p-3 text-xs text-muted-foreground" role="status">{t('loading')}</p> : null}
      {frame ? <iframe ref={frameRef} title={builtin ? (data?.name || 'Canvas Automation') : invocation.descriptor.toolName}
        sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" style={{ height }} className="block w-full border-0" /> : null}
      {ready && data && actions ? actions(data, (next) => setFrame((current) => current ? {
        ...current, result: { content: [], structuredContent: next },
      } : current)) : null}
      {approval ? <div className="space-y-2 border-t p-3 text-sm" role="group" aria-label={t('requestApproval', { tool: approval.tool })}>
        <p>{t('requestApproval', { tool: approval.tool })}</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all bg-muted p-2 text-xs">{JSON.stringify(approval.arguments, null, 2)}</pre>
        <div className="flex gap-2"><Button size="xs" onClick={() => void decide(true)}>{t('allow')}</Button><Button size="xs" variant="outline" onClick={() => void decide(false)}>{t('reject')}</Button></div>
      </div> : null}
      {busy ? <p className="p-3 text-xs" role="status">{t('loading')}</p> : null}
      {callFailed ? <p className="p-3 text-xs text-destructive" role="status">{t('callFailed')}</p> : null}
    </>}
    {reconnect ? <div className="p-3"><McpReconnectNotice connection={reconnect} /></div> : null}
  </section>;
}
