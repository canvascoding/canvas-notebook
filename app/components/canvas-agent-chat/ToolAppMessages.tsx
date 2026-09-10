'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ToolBatch } from '@/app/lib/chat/types';
import { getPiMessageDetails } from '@/app/lib/chat/message-content';
import { readMcpReconnectHint } from '@/app/lib/mcp/connection-health-types';
import { readToolAppInvocation, type ToolAppInvocation } from '@/app/lib/tool-apps/types';
import { ToolAppSlotPool } from '@/app/lib/tool-apps/slot-pool';
import { useMcpAppChatContext } from './McpAppChatContext';
import { McpReconnectNotice } from './McpReconnectNotice';
import { ToolAppWidget } from './ToolAppWidget';
import { AutomationAppActions } from './AutomationAppActions';

const frameSlots = new ToolAppSlotPool(4);

function ToolAppSlot(props: { invocation: ToolAppInvocation; sessionId: string; agentId: string }) {
  const t = useTranslations('chat.toolApp');
  const builtinApp = props.invocation.kind === 'builtin' ? props.invocation.descriptor : null;
  const elementRef = useRef<HTMLDivElement>(null);
  const [retainedHeight, setRetainedHeight] = useState(240);
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const release = frameSlots.acquire(setActive);
    return () => { release(); setActive(false); };
  }, [visible]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !active) return;
    const observer = new ResizeObserver(() => {
      setRetainedHeight(Math.max(120, element.getBoundingClientRect().height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  return <div ref={elementRef} data-testid="tool-app-slot" className="flow-root">
    {visible && active ? <ToolAppWidget {...props} actions={builtinApp
      ? (data, update, refresh) => <AutomationAppActions data={data} update={update} refresh={refresh}
        app={builtinApp}
        sessionId={props.sessionId} agentId={props.agentId} /> : undefined} /> : <div
      style={{ height: retainedHeight }} className="flex items-center p-3 text-xs text-muted-foreground"
      role="status">{t('loading')}</div>}
  </div>;
}

/** Both live results and persisted history pass through this single projection. */
export function ToolAppMessages({ batch }: { batch: ToolBatch }) {
  const chat = useMcpAppChatContext();
  if (!chat) return null;
  return <>{batch.calls.map((call) => {
    const message = call.message;
    if (!message) return null;
    const invocation = readToolAppInvocation(message.piMessage);
    const reconnect = readMcpReconnectHint(getPiMessageDetails(message.piMessage));
    if (!invocation && !reconnect) return null;
    return <div key={`${chat.sessionId}:${chat.agentId}:${call.toolCallId || call.id}`}>
      {invocation ? <ToolAppSlot invocation={invocation} {...chat} /> : null}
      {reconnect ? <McpReconnectNotice connection={reconnect} /> : null}
    </div>;
  })}</>;
}
