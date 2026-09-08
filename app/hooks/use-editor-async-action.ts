'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Editor } from '@tiptap/core';

/** Cancellation also rejects late responses from transports that ignore abort. */
export function useEditorAsyncAction(editor: Editor | null, open: boolean) {
  const scope = useMemo(() => editor && open ? { editor } : null, [editor, open]);
  const active = useRef<{ scope: { editor: Editor }; request: AbortController | null } | null>(null);
  useEffect(() => {
    if (!scope || scope.editor.isDestroyed) return;
    const current = { scope, request: null as AbortController | null };
    active.current = current;
    const close = () => {
      current.request?.abort();
      if (active.current === current) active.current = null;
    };
    scope.editor.on('destroy', close);
    return () => { close(); scope.editor.off('destroy', close); };
  }, [scope]);
  const cancel = useCallback(() => {
    const current = active.current;
    if (current && current.scope === scope) {
      current.request?.abort();
      active.current = null;
    }
  }, [scope]);
  const begin = useCallback(() => {
    const current = active.current;
    if (!scope || current?.scope !== scope || current.request || scope.editor.isDestroyed || !scope.editor.isEditable || scope.editor.view.composing) return null;
    current.request = new AbortController();
    return current.request;
  }, [scope]);
  const isCurrent = useCallback((request: AbortController) => active.current?.scope === scope
    && active.current?.request === request && !request.signal.aborted, [scope]);
  const finish = useCallback((request: AbortController) => {
    const current = active.current;
    if (current?.scope === scope && current.request === request) current.request = null;
  }, [scope]);
  return { begin, cancel, isCurrent, finish };
}
