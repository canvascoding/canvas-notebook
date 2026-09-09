'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { McpAppFrameTransport } from '@/app/lib/mcp/apps-browser-transport';
import type { McpAppInvocationDetails } from '@/app/lib/mcp/apps-types';
import { readMcpReconnectHint, type McpReconnectHint } from '@/app/lib/mcp/connection-health-types';
import { McpReconnectNotice } from './McpReconnectNotice';
import { Button } from '@/components/ui/button';

type Props = { descriptor: McpAppInvocationDetails['mcpApp']; input: unknown; result: unknown; sessionId: string; agentId: string };
type Approval = { tool: string; arguments: Record<string, unknown>; resolve: (result: CallToolResult) => void };
const failedResult = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

export function McpAppWidget({ descriptor, input, result, sessionId, agentId }: Props) {
  const t = useTranslations('chat.mcpApp');
  const locale = useLocale();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const approvalRef = useRef<Approval | null>(null);
  const activeCallRef = useRef<AbortController | null>(null);
  const [frame, setFrame] = useState<{ url: string; origin: string } | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [busy, setBusy] = useState(false);
  const [height, setHeight] = useState(280);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<'unavailable' | 'disabled' | 'oversized' | null>(null);
  const [callFailed, setCallFailed] = useState(false);
  const [reconnect, setReconnect] = useState<McpReconnectHint | null>(null);
  const [reload, setReload] = useState(0);
  const descriptorJson = JSON.stringify(descriptor);
  const payload = useMemo(() => {
    try {
      if (JSON.stringify({ input, result }).length > 2 * 1024 * 1024) return null;
      const parsed = CallToolResultSchema.safeParse(result);
      if (!parsed.success || !input || typeof input !== 'object' || Array.isArray(input)) return null;
      return { input: input as Record<string, unknown>, result: parsed.data };
    } catch { return null; }
  }, [input, result]);

  useEffect(() => {
    if (!payload) return;
    const abort = new AbortController();
    void fetch('/api/mcp/apps', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', signal: abort.signal,
      body: JSON.stringify({ action: 'render', app: JSON.parse(descriptorJson), sessionId, agentId }),
    }).then(async (response) => {
      const body = await response.json();
      if (abort.signal.aborted) return;
      if (!response.ok || !body.success) {
        setReconnect(readMcpReconnectHint(body));
        setError(response.status === 404 ? 'disabled' : 'unavailable');
        return;
      }
      const url = new URL(body.data.frameUrl);
      if (url.origin !== body.data.frameOrigin || url.hostname === window.location.hostname
        || !['http:', 'https:'].includes(url.protocol) || (window.location.protocol === 'https:' && url.protocol !== 'https:')
        || !/^\/__preview\/[A-Za-z0-9_-]{43}\/mcp-app\/frame$/u.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error();
      setFrame({ url: url.href, origin: url.origin });
    }).catch(() => { if (!abort.signal.aborted) setError('unavailable'); });
    return () => abort.abort();
  }, [agentId, descriptorJson, payload, reload, sessionId]);

  useEffect(() => {
    const iframe = frameRef.current;
    if (!frame || !iframe?.contentWindow || !payload || error) return;
    let active = true;
    let initialized = false;
    const bridge = new AppBridge(null, { name: 'Canvas Notebook', version: '1' }, { serverTools: {} }, {
      hostContext: { locale, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        platform: 'web', displayMode: 'inline', availableDisplayModes: ['inline'], containerDimensions: { maxHeight: 900 } },
    });
    const timer = window.setTimeout(() => { if (active && !initialized) setError('unavailable'); }, 20_000);
    bridge.onerror = () => { if (active) setError('unavailable'); };
    bridge.onsizechange = ({ height: nextHeight }) => {
      if (active && typeof nextHeight === 'number' && Number.isFinite(nextHeight)) setHeight(Math.max(160, Math.min(900, Math.ceil(nextHeight))));
    };
    bridge.oncalltool = async (params) => {
      if (!active || approvalRef.current || activeCallRef.current) return failedResult('Another approval or tool call is in progress.');
      if (JSON.stringify(params).length > 32_768) return failedResult('Request too large.');
      return new Promise<CallToolResult>((resolve) => {
        const request = { tool: params.name, arguments: params.arguments ?? {}, resolve };
        approvalRef.current = request;
        setApproval(request);
      });
    };
    bridge.oninitialized = () => {
      if (!active) return;
      initialized = true;
      window.clearTimeout(timer);
      setReady(true);
      void Promise.resolve(bridge.sendToolInput({ arguments: payload.input }))
        .then(() => bridge.sendToolResult(payload.result)).catch(() => { if (active) setError('unavailable'); });
    };
    const themeObserver = new MutationObserver(() => {
      if (active) bridge.setHostContext({ theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', locale });
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    void bridge.connect(new McpAppFrameTransport(iframe.contentWindow, frame.origin))
      .then(() => { if (active) iframe.src = frame.url; }).catch(() => { if (active) setError('unavailable'); });
    return () => {
      active = false; window.clearTimeout(timer); themeObserver.disconnect();
      approvalRef.current?.resolve(failedResult('The widget was closed.'));
      approvalRef.current = null; setApproval(null);
      activeCallRef.current?.abort(); activeCallRef.current = null; setBusy(false);
      void bridge.close().catch(() => undefined);
    };
  }, [frame, payload, locale, error]);

  const decide = async (allow: boolean) => {
    const request = approvalRef.current;
    if (!request) return;
    approvalRef.current = null; setApproval(null);
    if (!allow) { request.resolve(failedResult('The user rejected this tool call.')); return; }
    const abort = new AbortController();
    activeCallRef.current = abort; setBusy(true); setCallFailed(false);
    try {
      const response = await fetch('/api/mcp/apps', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', signal: abort.signal,
        body: JSON.stringify({ action: 'call', app: descriptor, sessionId, agentId, tool: request.tool, arguments: request.arguments }),
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

  return <section data-testid="mcp-app-widget" className="mt-2 w-full max-w-3xl overflow-hidden rounded-lg border bg-background">
    {!payload || error ? <div className="space-y-2 p-3 text-xs text-muted-foreground">
      <p>{t(!payload ? 'oversized' : error!)}</p>
      {payload ? <Button size="xs" variant="outline" onClick={() => {
        setFrame(null); setError(null); setReady(false); setReconnect(null); setCallFailed(false);
        setReload((value) => value + 1);
      }}>{t('reload')}</Button> : null}
    </div> : <>
      {!ready ? <p className="p-3 text-xs text-muted-foreground" role="status">{t('loading')}</p> : null}
      {frame ? <iframe ref={frameRef} title={descriptor.toolName} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" style={{ height }} className="w-full border-0" /> : null}
      {approval ? <div className="space-y-2 border-t p-3 text-sm" role="group" aria-label={t('requestApproval', { tool: approval.tool })}>
        <p>{t('requestApproval', { tool: approval.tool })}</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{JSON.stringify(approval.arguments, null, 2)}</pre>
        <div className="flex gap-2"><Button size="xs" onClick={() => void decide(true)}>{t('allow')}</Button><Button size="xs" variant="outline" onClick={() => void decide(false)}>{t('reject')}</Button></div>
      </div> : null}
      {busy ? <p className="p-3 text-xs" role="status">{t('loading')}</p> : null}
      {callFailed ? <p className="p-3 text-xs text-destructive" role="status">{t('callFailed')}</p> : null}
    </>}
    {reconnect ? <div className="p-3"><McpReconnectNotice connection={reconnect} /></div> : null}
  </section>;
}
