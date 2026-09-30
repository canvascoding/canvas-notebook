import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import type { TodoItem } from '../app/lib/todos/client-types';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';

async function main() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://canvas.invalid/de/notebook' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const loader = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  const reads: Array<{ path: string; workspaceId: string }> = [];
  loader._load = (request, parent, isMain) => {
    if (request === 'next-intl') return { useTranslations: () => (key: string) => key };
    if (request === '@/i18n/navigation') return { Link: ({ children, ...props }: { children: React.ReactNode }) => React.createElement('a', props, children) };
    if (request === '@/app/lib/files/client') return { readWorkspaceFile: async (path: string, options: { workspaceId: string }) => { reads.push({ path, workspaceId: options.workspaceId }); return { content: '---\ntitle: Personal file title\n---\nContent' }; } };
    if (request === '@/app/components/shared/MarkdownRenderer') return { MarkdownRenderer: ({ content }: { content: string }) => React.createElement('p', {}, content) };
    return originalLoad.call(loader, request, parent, isMain);
  };
  try {
    const { TodoDetailPanel } = await import('../app/apps/todos/components/TodoDetailPanel');
    const { useWorkspaceStore } = await import('../app/store/workspace-store');
    const personal = { id: 'personal-workspace', type: 'personal', name: 'Personal', permissions: { canRead: true } } as ClientWorkspaceSummary;
    const team = { id: 'active-team', type: 'team', name: 'Team', permissions: { canRead: true } } as ClientWorkspaceSummary;
    const todo = {
      id: 'personal-todo', canWrite: true, title: 'Personal todo', status: 'open', priority: 'normal', readState: 'read',
      scopeKind: 'user', workspaceType: 'personal', description: null, createdAt: null, updatedAt: null,
      fileLinks: [{ id: 'personal-file', workspaceId: null, workspaceType: 'personal', workspacePath: '/private.md', label: null }],
    } as unknown as TodoItem;
    const props = { todo, locale: 'en', followUpComment: '', isMutating: false, isSendingFollowUp: false,
      formatCategoryName: () => 'None', onEdit: () => {}, onRestore: () => {}, onToggleDone: () => {}, onMarkSeen: () => {},
      onOpenSession: () => {}, onUpdateFollowUpComment: () => {}, onSendFollowUp: () => {} };
    const container = document.getElementById('root')!;
    const root = createRoot(container);
    const settle = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
    await React.act(async () => {
      useWorkspaceStore.setState({ initialized: false, activeWorkspaceId: team.id, workspaces: [team, personal] });
      root.render(React.createElement(TodoDetailPanel, props));
      await settle();
    });
    assert.equal(reads.length, 0, 'No metadata read before workspace hydration.');
    assert.equal(container.querySelector('a[href*="notebook"]'), null, 'No unscoped notebook link before workspace hydration.');
    assert.ok(container.querySelector('button[disabled]'), 'File action is disabled until the personal workspace is ready.');
    await React.act(async () => { useWorkspaceStore.setState({ initialized: true }); await settle(); });
    assert.deepEqual(reads, [{ path: '/private.md', workspaceId: personal.id }]);
    const personalLink = container.querySelector('a[href*="notebook"]')!;
    assert.equal(new URL(personalLink.getAttribute('href')!, dom.window.location.href).searchParams.get('workspaceId'), personal.id);
    assert.match(personalLink.textContent || '', /Personal file title/);
    await React.act(async () => {
      root.render(React.createElement(TodoDetailPanel, { ...props, todo: { ...todo, fileLinks: [{ ...todo.fileLinks[0], id: 'team-file', workspaceId: team.id, workspaceType: 'team' }] } }));
      await settle();
    });
    assert.equal(reads.at(-1)?.workspaceId, team.id, 'Explicit workspace links retain their own scope.');
    assert.equal(new URL(container.querySelector('a[href*="notebook"]')!.getAttribute('href')!, dom.window.location.href).searchParams.get('workspaceId'), team.id);
    const errorTodo = { ...todo, sourceType: 'agent' as const, emailNotificationError: 'Missing configuration' };
    await React.act(async () => { root.render(React.createElement(TodoDetailPanel, { ...props, todo: errorTodo })); await settle(); });
    assert.ok(container.querySelector('a[href*="notebook"]'));
    assert.ok(container.querySelector('a[href="/settings?tab=integrations"]'));
    await React.act(async () => { root.render(React.createElement(TodoDetailPanel, { ...props, todo: errorTodo, navigationDisabled: true })); await settle(); });
    assert.equal(container.querySelector('a[href*="notebook"]'), null, 'Dirty or busy popup must not navigate via a file link.');
    assert.equal(container.querySelector('a[href="/settings?tab=integrations"]'), null, 'Dirty or busy popup must not navigate to settings.');
    assert.ok(container.querySelectorAll('button[disabled]').length >= 2);
    await React.act(async () => { root.render(React.createElement(TodoDetailPanel, { ...props, todo: errorTodo, navigationDisabled: false })); await settle(); });
    assert.ok(container.querySelector('a[href*="notebook"]'), 'File navigation resumes once the draft is saved or discarded.');
    assert.ok(container.querySelector('a[href="/settings?tab=integrations"]'), 'Settings navigation resumes once safe.');
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 3);
    const dueAt = `${deadline.getFullYear()}-${String(deadline.getMonth() + 1).padStart(2, '0')}-${String(deadline.getDate()).padStart(2, '0')}T00:00:00.000Z`;
    const practicalTodo = { ...todo, description: 'Check the final release notes before shipping.', dueAt,
      remindAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      assignee: { id: 'alice', name: 'Alice Example', email: 'alice@example.test', image: '/images/alice.png' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), fileLinks: [] };
    await React.act(async () => { root.render(React.createElement(TodoDetailPanel, { ...props, todo: practicalTodo })); await settle(); });
    assert.match(container.querySelector('[data-testid="todo-detail-content"]')?.textContent || '', /Check the final release notes/);
    assert.match(container.querySelector('[data-testid="todo-detail-due"]')?.textContent || '', /in 3 days/);
    assert.match(container.querySelector('[data-testid="todo-detail-reminder"]')?.textContent || '', /in 2 hours/);
    assert.equal(container.querySelector('[data-testid="todo-detail-files"]'), null, 'Empty file sections are omitted.');
    assert.equal(container.querySelector('[data-testid="todo-assignee-avatar"] img')?.getAttribute('src'), '/images/alice.png');
    assert.equal(container.querySelector('details')?.hasAttribute('open'), false, 'Secondary timestamps are collapsed.');
    await React.act(async () => { root.render(React.createElement(TodoDetailPanel, { ...props, todo: { ...practicalTodo, assignee: { ...practicalTodo.assignee, image: null } } })); await settle(); });
    assert.match(container.querySelector('[data-testid="todo-assignee-avatar"]')?.textContent || '', /AE/);
    const emptyTodo = { ...todo, description: null, dueAt: null, remindAt: null, category: null, assignee: null, fileLinks: [] };
    await React.act(async () => { root.render(React.createElement(TodoDetailPanel, { ...props, todo: emptyTodo })); await settle(); });
    for (const testId of ['todo-detail-due', 'todo-detail-reminder', 'todo-detail-content', 'todo-detail-files', 'todo-detail-assignee']) {
      assert.equal(container.querySelector(`[data-testid="${testId}"]`), null, `Empty ${testId} is omitted.`);
    }
    assert.doesNotMatch(container.textContent || '', /noDueAt|noReminder|noDescription|noFiles|unassigned/);
    await React.act(async () => root.unmount());
    console.log('todo-personal-file-links-test: no unscoped reads/links before hydration; personal links override active team; explicit team scope preserved; dirty popup navigation blocked and restored; useful relative dates, avatar and empty fields verified');
  } finally { loader._load = originalLoad; dom.window.close(); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
