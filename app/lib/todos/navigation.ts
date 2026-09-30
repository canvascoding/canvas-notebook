/** Todo links remain navigable when JavaScript is unavailable or a new tab is requested. */
export function buildTodoPopupHref(todoId: string, locale?: 'de' | 'en'): string {
  return `${locale ? `/${locale}/` : '/'}?${new URLSearchParams({ todo: todoId })}`;
}

/** The explicit full-page action bypasses the global detail popup. */
export function buildTodoPageHref(todoId: string, workspaceId?: string | null): string {
  const params = new URLSearchParams({ todo: todoId, todoView: 'page' });
  if (workspaceId) params.set('workspaceId', workspaceId);
  return `/todos?${params}`;
}

export function todoIdFromSearchParams(params: Pick<URLSearchParams, 'get' | 'getAll'>): string | null {
  if (params.get('todoView') === 'page' || params.getAll('todo').length !== 1) return null;
  const todoId = params.get('todo');
  return todoId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(todoId) ? todoId : null;
}

/** Restrict interception to Canvas Todo links, never an unrelated or external URL. */
export function todoIdFromHref(href: string, baseHref: string): string | null {
  try {
    const base = new URL(baseHref);
    const url = new URL(href, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin
      || url.username || url.password
      || !/^\/(?:(?:de|en)(?:\/(?:todos\/?)?)?|todos\/?)?$/u.test(url.pathname)) return null;
    return todoIdFromSearchParams(url.searchParams);
  } catch {
    return null;
  }
}

export function isUnmodifiedPrimaryClick(event: {
  button: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return event.button === 0 && !event.defaultPrevented
    && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}
