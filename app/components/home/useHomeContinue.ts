'use client';

import { useEffect, useRef, useState } from 'react';
import { loadQuickAccessFiles } from '@/app/lib/files/quick-access-client';
import type { QuickAccessPage, QuickAccessView } from '@/app/lib/files/quick-access';
import type { ContinueFilter, HomeChatPage } from '@/app/lib/home/continue-items';

type Snapshot = { key: string; files: QuickAccessPage | null; chats: HomeChatPage | null; filesFailed: boolean; chatsFailed: boolean };

export function useHomeContinue(workspaceId: string | undefined, filter: ContinueFilter, view: QuickAccessView, query: string, revision: number) {
  const key = JSON.stringify([workspaceId, filter, view, query, revision]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(async () => {
      deadline = setTimeout(() => controller.abort(), 12_000);
      const previous = snapshotRef.current?.key === key ? snapshotRef.current : null;
      const [files, chats] = await Promise.allSettled([
        filter === 'chats' ? Promise.resolve(null) : previous?.files ? Promise.resolve(previous.files) : loadQuickAccessFiles(workspaceId, view, query, 10, controller.signal),
        filter === 'files' ? Promise.resolve(null) : previous?.chats ? Promise.resolve(previous.chats) : (async (): Promise<HomeChatPage> => {
          const params = new URLSearchParams({ workspaceId, q: query, limit: '10' });
          const response = await fetch(`/api/home/chats?${params}`, { signal: controller.signal, credentials: 'include', cache: 'no-store' });
          if (!response.ok) throw new Error('Failed to load recent chats');
          const payload = await response.json();
          if (!payload.success || !Array.isArray(payload.data?.chats)) throw new Error('Invalid recent chats response');
          return payload.data;
        })(),
      ]);
      clearTimeout(deadline);
      if (!active) return;
      const next = { key, files: files.status === 'fulfilled' ? files.value : null, chats: chats.status === 'fulfilled' ? chats.value : null, filesFailed: files.status === 'rejected', chatsFailed: chats.status === 'rejected' };
      snapshotRef.current = next;
      setSnapshot(next);
    }, query ? 220 : 0);
    return () => { active = false; clearTimeout(timer); clearTimeout(deadline); controller.abort(); };
  }, [key, retry, workspaceId, filter, view, query]);

  const current = snapshot?.key === key ? snapshot : null;
  return { ...current, loading: !workspaceId || !current, retry: () => setRetry(value => value + 1) };
}
