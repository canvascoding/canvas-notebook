'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ToolBatch } from '@/app/lib/chat/types';
import { getPiMessageDetails } from '@/app/lib/chat/message-content';
import { readMcpReconnectHint } from '@/app/lib/mcp/connection-health-types';
import { readToolAppInvocations, type ToolAppInvocation } from '@/app/lib/tool-apps/types';
import { ToolAppSlotPool } from '@/app/lib/tool-apps/slot-pool';
import { useMcpAppChatContext } from './McpAppChatContext';
import { McpReconnectNotice } from './McpReconnectNotice';
import { ToolAppLoadingSkeleton, ToolAppWidget } from './ToolAppWidget';
import { BuiltinToolAppActions } from './BuiltinToolAppActions';

const frameSlots = new ToolAppSlotPool(4);
const DEFAULT_RETAINED_HEIGHT = 240;
const MAX_RETAINED_HEIGHTS = 200;
const retainedHeights = new Map<string, number>();

function readRetainedHeight(key: string): number {
  const height = retainedHeights.get(key);
  if (height === undefined) return DEFAULT_RETAINED_HEIGHT;
  retainedHeights.delete(key);
  retainedHeights.set(key, height);
  return height;
}

function retainHeight(key: string, height: number): void {
  retainedHeights.delete(key);
  retainedHeights.set(key, height);
  while (retainedHeights.size > MAX_RETAINED_HEIGHTS) {
    const oldest = retainedHeights.keys().next().value;
    if (typeof oldest !== 'string') break;
    retainedHeights.delete(oldest);
  }
}

function invocationKey(invocation: ToolAppInvocation): string {
  if (invocation.kind === 'builtin') {
    return `${invocation.descriptor.resourceUri}:${invocation.descriptor.entityId}`;
  }
  return `${invocation.descriptor.connectionId}:${invocation.descriptor.toolName}:${invocation.descriptor.resourceUri}`;
}

function ToolAppSlot(props: { invocation: ToolAppInvocation; sessionId: string; agentId: string; instanceKey: string }) {
  const t = useTranslations('chat.toolApp');
  const builtinApp = props.invocation.kind === 'builtin' ? props.invocation.descriptor : null;
  const elementRef = useRef<HTMLDivElement>(null);
  const deactivateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retainedHeight, setRetainedHeight] = useState(() => readRetainedHeight(props.instanceKey));
  const [nearViewport, setNearViewport] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      let disposed = false;
      queueMicrotask(() => { if (!disposed) setNearViewport(true); });
      return () => { disposed = true; };
    }
    const scrollRoot = element.closest<HTMLElement>('[data-testid="chat-scroll-region"]');
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        if (deactivateTimerRef.current) clearTimeout(deactivateTimerRef.current);
        deactivateTimerRef.current = null;
        setNearViewport(true);
        return;
      }
      if (deactivateTimerRef.current) clearTimeout(deactivateTimerRef.current);
      deactivateTimerRef.current = setTimeout(() => {
        deactivateTimerRef.current = null;
        setNearViewport(false);
      }, 750);
    }, { root: scrollRoot, rootMargin: '480px 0px' });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (deactivateTimerRef.current) clearTimeout(deactivateTimerRef.current);
      deactivateTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!nearViewport) return;
    const release = frameSlots.acquire(setActive);
    return () => { release(); setActive(false); };
  }, [nearViewport]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !active) return;
    const content = element.firstElementChild;
    if (!(content instanceof HTMLElement)) return;
    const observer = new ResizeObserver(([entry]) => {
      const measured = entry.borderBoxSize[0]?.blockSize || entry.contentRect.height;
      const nextHeight = Math.max(120, Math.ceil(measured || content.offsetHeight));
      retainHeight(props.instanceKey, nextHeight);
      setRetainedHeight((current) => current === nextHeight ? current : nextHeight);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [active, props.instanceKey]);

  return <div ref={elementRef} data-testid="tool-app-slot" className="flow-root">
    {nearViewport && active ? <ToolAppWidget {...props} reservedHeight={retainedHeight} actions={builtinApp
      ? (data, update, refresh) => <BuiltinToolAppActions data={data} update={update} refresh={refresh}
        app={builtinApp}
        sessionId={props.sessionId} agentId={props.agentId} /> : undefined} /> : <div
      style={{ height: retainedHeight }}
      className="relative my-2 w-full max-w-3xl overflow-hidden rounded-[var(--radius)] border bg-background">
      <ToolAppLoadingSkeleton label={t('loading')} animated={nearViewport} />
    </div>}
  </div>;
}

/** Both live results and persisted history pass through this single projection. */
export function ToolAppMessages({ batch }: { batch: ToolBatch }) {
  const chat = useMcpAppChatContext();
  if (!chat) return null;
  return <>{batch.calls.map((call) => {
    const message = call.message;
    if (!message) return null;
    const invocations = readToolAppInvocations(message.piMessage);
    const reconnect = readMcpReconnectHint(getPiMessageDetails(message.piMessage));
    if (!invocations.length && !reconnect) return null;
    const callKey = call.toolCallId || call.id;
    return <div key={`${chat.sessionId}:${chat.agentId}:${callKey}`}>
      {invocations.map(invocation => {
        const key = `${chat.sessionId}:${chat.agentId}:${callKey}:${invocationKey(invocation)}`;
        return <ToolAppSlot key={key} instanceKey={key} invocation={invocation} {...chat} />;
      })}
      {reconnect ? <McpReconnectNotice connection={reconnect} /> : null}
    </div>;
  })}</>;
}
