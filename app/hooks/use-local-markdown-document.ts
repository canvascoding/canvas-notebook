'use client';

import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { LocalMarkdownOwner } from '../lib/editor/local-markdown-owner';
import type { LocalMarkdownSnapshot } from '../lib/editor/local-markdown-document';
import type { MarkdownFrontmatterMode } from '../lib/markdown/editor-document';

const emptySnapshot = (): LocalMarkdownSnapshot | null => null;
const emptySubscribe = () => () => {};

/** One local document for the parent editor lifetime, across Read/Rich/Source.
 * Effects update permissions and callbacks at commit time, including StrictMode. */
export function useLocalMarkdownDocument({ scope, value, enabled, frontmatter, readOnly, externalValueSync, onChange }: {
  scope: string; value: string; enabled: boolean; frontmatter: MarkdownFrontmatterMode; readOnly: boolean;
  externalValueSync: 'always' | 'when-blurred'; onChange?: (markdown: string) => void;
}) {
  const [current, setCurrent] = useState(() => new LocalMarkdownOwner(scope, value, enabled, frontmatter, readOnly));
  let owner = current;
  if (owner.scope !== scope) {
    owner = new LocalMarkdownOwner(scope, value, enabled, frontmatter, readOnly);
    setCurrent(owner);
  }
  const document = owner.document;
  const snapshot = useSyncExternalStore(document?.subscribe ?? emptySubscribe, document?.getSnapshot ?? emptySnapshot, document?.getSnapshot ?? emptySnapshot);

  useLayoutEffect(() => owner.connect(), [owner]);
  useLayoutEffect(() => { owner.update(value, readOnly, externalValueSync, onChange); },
    [externalValueSync, onChange, owner, readOnly, value]);
  const setFocused = useCallback((focused: boolean) => owner.setFocused(focused), [owner]);
  return { document, snapshot, setFocused };
}
