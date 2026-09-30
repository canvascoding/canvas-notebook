'use client';

import React from 'react';
import type { ChatFileReference } from '@/app/lib/chat/tool-file-references';
import { summarizeFileChanges } from '@/app/lib/chat/file-change-summary';
import { readFileChangeAppData, type FileChangeAppData } from '@/app/lib/tool-apps/file-change-data';
import { FILE_CHANGE_APP_URI, isToolAppRecord, type BuiltinToolAppDescriptor } from '@/app/lib/tool-apps/types';
import { FileReferenceCard, type FileReferenceViewState } from './FileReferenceCard';
import { useMcpAppChatContext } from './McpAppChatContext';

const MAX_SUMMARY_APPS = 500;
const BATCH_SIZE = 100;
type LoadResult = { key: string; groups: FileChangeAppData[]; state: 'loading' | 'ready' | 'error' };

function retryDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 700);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Native bulk summaries stay dormant until their completed response is visible. */
export function RunFileReferenceCard({ references, changeReferences = [], omittedCount = 0, changeApps = [], viewState, onViewStateChange }: {
  references: ChatFileReference[];
  changeReferences?: ChatFileReference[];
  omittedCount?: number;
  changeApps?: BuiltinToolAppDescriptor[];
  viewState?: FileReferenceViewState;
  onViewStateChange?: (state: FileReferenceViewState) => void;
}) {
  const chat = useMcpAppChatContext();
  const sessionId = chat?.sessionId;
  const agentId = chat?.agentId;
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(() => typeof IntersectionObserver === 'undefined');
  const [refreshVersion, setRefreshVersion] = React.useState(0);
  const fileChangeApps = changeApps.filter(app => app.resourceUri === FILE_CHANGE_APP_URI);
  const truncated = fileChangeApps.length > MAX_SUMMARY_APPS;
  const appsKey = JSON.stringify(fileChangeApps.slice(0, MAX_SUMMARY_APPS));
  const apps = React.useMemo(() => {
    const parsed = JSON.parse(appsKey) as BuiltinToolAppDescriptor[];
    return [...new Map(parsed.map(app => [`${app.entityId}:${app.toolCallId}`, app])).values()];
  }, [appsKey]);
  const key = JSON.stringify([sessionId, agentId, appsKey, refreshVersion]);
  const [loaded, setLoaded] = React.useState<LoadResult>({ key: '', groups: [], state: 'loading' });

  React.useEffect(() => {
    const node = hostRef.current;
    if (!node || visible) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '100px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  React.useEffect(() => {
    if (!visible || !apps.length || !sessionId || !agentId) return;
    const controller = new AbortController();
    const { signal } = controller;
    const groups = new Map<string, FileChangeAppData>();
    void (async () => {
      let unavailable = false;
      for (let offset = 0; offset < apps.length; offset += BATCH_SIZE) {
        let pending = apps.slice(offset, offset + BATCH_SIZE);
        for (let attempt = 0; pending.length && attempt < 3; attempt++) {
          if (attempt) await retryDelay(signal);
          const response = await fetch('/api/chat/file-changes', {
            method: 'POST', credentials: 'same-origin', signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, agentId, apps: pending }),
          });
          if (!response.ok) throw new Error('File change summary unavailable');
          const payload: unknown = await response.json();
          if (signal.aborted) return;
          if (!isToolAppRecord(payload) || payload.success !== true || !isToolAppRecord(payload.data)
            || !Array.isArray(payload.data.groups) || !Array.isArray(payload.data.unavailable)
            || payload.data.groups.length > pending.length || payload.data.unavailable.length > pending.length) {
            throw new Error('Invalid file change summary');
          }
          const requested = new Map(pending.map(app => [app.entityId, app]));
          const seen = new Set<string>();
          for (const value of payload.data.groups) {
            const group = readFileChangeAppData(value);
            if (!group || !requested.has(group.id) || requested.get(group.id)?.operation !== group.operation
              || seen.has(group.id)) throw new Error('Invalid file change group');
            seen.add(group.id);
            groups.set(group.id, group);
          }
          const retry: BuiltinToolAppDescriptor[] = [];
          for (const failure of payload.data.unavailable) {
            if (!isToolAppRecord(failure) || typeof failure.entityId !== 'string'
              || !requested.has(failure.entityId) || requested.get(failure.entityId)?.toolCallId !== failure.toolCallId
              || seen.has(failure.entityId) || ![403, 404, 413, 425].includes(Number(failure.status))
              || typeof failure.retryable !== 'boolean') throw new Error('Invalid file change availability');
            seen.add(failure.entityId);
            if (failure.status === 425 && failure.retryable && attempt < 2) retry.push(requested.get(failure.entityId)!);
            else unavailable = true;
          }
          if (seen.size !== pending.length) throw new Error('Incomplete file change summary');
          pending = retry;
        }
      }
      if (!signal.aborted) setLoaded({ key, groups: [...groups.values()], state: unavailable ? 'error' : 'ready' });
    })().catch(() => {
      if (!signal.aborted) setLoaded({ key, groups: [...groups.values()], state: 'error' });
    });
    return () => controller.abort();
  }, [visible, key, apps, sessionId, agentId]);

  const result = loaded.key === key ? loaded : { groups: [], state: 'loading' as const };
  const state = !apps.length ? 'ready' : !chat ? 'error' : result.state;
  const rows = React.useMemo(() => summarizeFileChanges([...references, ...changeReferences], result.groups, apps, state),
    [references, changeReferences, result.groups, apps, state]);
  return <div ref={hostRef}>
    <FileReferenceCard references={references} summaryRows={rows} omittedCount={omittedCount}
      viewState={viewState} onViewStateChange={onViewStateChange}
      onRefresh={apps.length ? () => { setVisible(true); setRefreshVersion(value => value + 1); } : undefined}
      refreshing={apps.length > 0 && Boolean(chat) && state === 'loading'} loadError={state === 'error' || truncated} />
  </div>;
}
