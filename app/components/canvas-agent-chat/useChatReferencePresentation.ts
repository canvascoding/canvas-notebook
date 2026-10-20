'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ChatBodyV1 } from '@/app/lib/chat/chat-body-contracts';
import type { ChatExtensionOptionsTarget } from '@/app/lib/chat/extension-options-contracts';
import { requestChatExtensionOptions } from '@/app/lib/chat/extension-options-client';
import { chatInlineReferenceIconKey, type ChatInlineReferenceIcons } from '@/app/lib/chat/inline-editor';
import { openedDocumentAuthScope, isOpenedDocumentAuthCurrent, subscribeOpenedDocumentAuthInvalidation } from '@/app/lib/collaboration/opened-document-registry';

/** Icons are descriptive projections of exact selections, independently of captions and authority. */
export function useChatReferencePresentation(target: ChatExtensionOptionsTarget | null, bodies: readonly ChatBodyV1[]): ChatInlineReferenceIcons {
  const auth = useSyncExternalStore(subscribeOpenedDocumentAuthInvalidation, openedDocumentAuthScope, () => null);
  const scope = JSON.stringify([auth?.userId, auth?.sessionId, auth?.epoch, target]);
  const selections = new Map(bodies.flatMap(body => body.bundles.map(bundle =>
    [chatInlineReferenceIconKey(bundle.primary.selection), bundle.primary.selection] as const)));
  const serialized = JSON.stringify([...selections.values()]);
  const selectionList = useMemo(() => [...selections.values()], [serialized]); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState<{ scope: string; icons: ChatInlineReferenceIcons; resolved: string[] }>({ scope: '', icons: {}, resolved: [] });
  const visible = state.scope === scope ? state : { scope, icons: {}, resolved: [] };
  const unresolved = selectionList.filter(selection => !visible.resolved.includes(chatInlineReferenceIconKey(selection)));
  const pendingKey = JSON.stringify(unresolved);
  useEffect(() => {
    if (!target || !unresolved.length) return;
    const controller = new AbortController();
    void (async () => {
      for (let index = 0; index < unresolved.length && !controller.signal.aborted; index += 20) {
        const batch = unresolved.slice(index, index + 20);
        try {
          const result = await requestChatExtensionOptions({ operation: 'presentation', target, selections: batch }, controller.signal);
          if (controller.signal.aborted || !isOpenedDocumentAuthCurrent(auth)) return;
          setState(previous => {
            const current = previous.scope === scope ? previous : { scope, icons: {}, resolved: [] };
            return { scope, icons: { ...current.icons, ...Object.fromEntries(result.entries.map(entry =>
              [chatInlineReferenceIconKey(entry.selection), entry.publicIcon])) },
            resolved: [...new Set([...current.resolved, ...batch.map(chatInlineReferenceIconKey)])] };
          });
        } catch { /* A missing image remains initials and never changes the stored selection. */ }
      }
    })();
    return () => controller.abort();
    // The immutable namespace and full selection vector govern these metadata requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, pendingKey]);
  return visible.icons;
}
