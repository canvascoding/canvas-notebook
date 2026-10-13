'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { writePlainTextToClipboard } from '@/app/lib/clipboard/browser';

export function useChatMarkdownCopy(scope: { sessionId: string | null; agentId: string; workspaceId?: string | null }) {
  const t = useTranslations('chat');
  const [copyingScope, setCopyingScope] = useState<{ key: string; controller: AbortController } | null>(null);
  const request = useRef<AbortController | null>(null);
  const scopeKey = JSON.stringify([scope.sessionId, scope.agentId, scope.workspaceId]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [scopeKey]);

  async function copyChatMarkdown() {
    if (!scope.sessionId || !scope.workspaceId || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setCopyingScope({ key: scopeKey, controller });
    try {
      const query = new URLSearchParams({ agentId: scope.agentId, workspaceId: scope.workspaceId });
      const exported = (async () => {
        const response = await fetch(`/api/sessions/${encodeURIComponent(scope.sessionId!)}/export?${query}`, {
          cache: 'no-store', credentials: 'include', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Chat export failed.');
        const payload: { markdown?: unknown; hasWarnings?: boolean } = await response.json();
        if (typeof payload.markdown !== 'string') throw new Error('Invalid chat export.');
        controller.signal.throwIfAborted();
        return { markdown: payload.markdown, hasWarnings: payload.hasWarnings === true };
      })();
      // Promise-backed ClipboardItem preserves the click's user activation in Safari.
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        const clipboardPayload = exported.then(({ markdown }) => new Blob([markdown], { type: 'text/plain' }));
        // Permission can be denied before the browser consumes the promised Blob.
        void clipboardPayload.catch(() => {});
        await Promise.all([exported, navigator.clipboard.write([new ClipboardItem({
          'text/plain': clipboardPayload,
        })])]);
      } else {
        await writePlainTextToClipboard((await exported).markdown);
      }
      controller.signal.throwIfAborted();
      const result = await exported;
      if (result.hasWarnings) toast.warning(t('chatMarkdownCopiedIncomplete'));
      else toast.success(t('chatMarkdownCopied'));
    } catch {
      if (!controller.signal.aborted) toast.error(t('chatMarkdownCopyFailed'));
      controller.abort();
    } finally {
      if (request.current === controller) {
        request.current = null;
      }
      setCopyingScope((current) => current?.controller === controller ? null : current);
    }
  }

  return { copyChatMarkdown, isCopyingMarkdown: copyingScope?.key === scopeKey && !copyingScope.controller.signal.aborted };
}
