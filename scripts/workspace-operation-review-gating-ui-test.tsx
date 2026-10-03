import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import messages from '../messages/en.json';
import type * as Toolbar from '../app/components/file-browser/FileToolbar';
import type * as Settings from '../app/components/settings/ExperimentalFeaturesSettingsPanel';
import type * as Availability from '../app/components/file-version-center/DocumentReviewAvailabilityProvider';
import type * as NotificationActions from '../app/components/notifications/notification-actions';
import type { NotificationItem } from '../app/components/notifications/notification-summary';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test/en/settings?tab=experimental' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'CustomEvent', 'Event', 'MouseEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
const passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
const Button = ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {variant?: string; size?: string}) => <button {...props}>{children}</button>;
const translate = (namespace: string) => (key: string) => {
  const value = `${namespace}.${key}`.split('.').reduce<unknown>((object, part) => object && typeof object === 'object' ? (object as Record<string, unknown>)[part] : null, messages);
  assert.equal(typeof value, 'string', `missing translation: ${namespace}.${key}`);
  return String(value);
};
async function compile<T>(relativePath: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(relativePath);
  const native = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const exports = {} as T;
  new Function('require', 'module', 'exports', source)((name: string) => name in mocks ? mocks[name] : native(name), { exports }, exports);
  return exports;
}

async function verifyDelayedNotificationNavigation() {
  const opens: string[] = [];
  const switches: string[] = [];
  let activeWorkspaceId = 'current-workspace';
  let scope: unknown = { userId: 'user-one', sessionId: 'session-one', epoch: 1 };
  let hydrate: () => Promise<void> = async () => {};
  let switchWorkspace: (workspaceId: string) => Promise<boolean> = async (workspaceId) => {
    switches.push(workspaceId); activeWorkspaceId = workspaceId; return true;
  };
  let status: unknown = null;
  const navigation = await compile<typeof NotificationActions>('app/components/notifications/notification-actions.ts', {
    '@/app/lib/collaboration/opened-document-registry': { openedDocumentAuthScope: () => scope },
    '@/app/lib/workspaces/navigation-sync': { beginExternalWorkspaceNavigation: () => () => {} },
    '@/app/store/workspace-store': { useWorkspaceStore: { getState: () => ({
      activeWorkspaceId, hydrateWorkspaces: () => hydrate(), setActiveWorkspace: (id: string) => switchWorkspace(id),
    }) } },
    '@/app/store/file-version-center-store': { openVersionCenterFromNotification: () => opens.push('document') },
    '@/app/store/workspace-operation-review-store': { openWorkspaceOperationReview: () => opens.push('file-operation') },
    '@/app/store/workspace-path-operation-store': { openWorkspacePathOperationStatus: async (target: {workspaceId: string}) => {
      status = target; activeWorkspaceId = target.workspaceId; return true;
    } },
  });
  const item: NotificationItem = { id: 'file-change:old-operation', type: 'file.change_review_required', title: 'Review',
    detail: null, occurredAt: '2026-10-03T12:00:00Z', unread: true, priority: 'normal',
    workspaceId: 'old-workspace', workspaceName: 'Old workspace', fileChangeReason: 'needs_review',
    target: { kind: 'file_change', workspaceId: 'old-workspace', lineageId: 'old-lineage', operationId: 'old-operation' } };
  const legacyTarget = { workspaceId: 'old-workspace', reviewId: 'old-review-12345678' };
  const latestTarget = { workspaceId: 'latest-workspace', reviewId: 'latest-review-12345678' };
  for (const start of [() => navigation.openFileChangeReviewNotification(item),
    () => navigation.openWorkspaceOperationNotificationTarget(legacyTarget)]) {
    for (const openLatest of [() => navigation.openWorkspaceOperationNotificationTarget(latestTarget, { reviewCenterEnabled: false }),
      () => navigation.openFileChangeReviewNotification({ ...item, workspaceId: 'latest-workspace',
        target: { ...item.target as Extract<NotificationItem['target'], {kind: 'file_change'}>, workspaceId: 'latest-workspace' } }, { reviewCenterEnabled: false })]) {
      let release!: () => void;
      const delayed = new Promise<void>((resolve) => { release = resolve; });
      hydrate = () => delayed;
      const older = start();
      await openLatest();
      const latestStatus = status;
      release(); await older;
      assert.equal(status, latestStatus, 'a delayed ON request cannot replace newer OFF status');
      assert.equal(activeWorkspaceId, 'latest-workspace');
      assert.equal(opens.length, 0); assert.equal(switches.length, 0, 'superseded hydration cannot switch workspace');
    }
    let release!: () => void;
    hydrate = () => new Promise<void>((resolve) => { release = resolve; });
    const oldIdentity = start();
    scope = { userId: 'other-user', sessionId: 'other-session', epoch: 2 };
    release(); await oldIdentity;
    assert.equal(opens.length, 0); assert.equal(switches.length, 0, 'auth change during hydration cancels legacy navigation');

    hydrate = async () => {};
    let beganSwitch!: () => void;
    const switching = new Promise<void>((resolve) => { beganSwitch = resolve; });
    let finishSwitch!: () => void;
    switchWorkspace = async (workspaceId) => { beganSwitch(); await new Promise<void>((resolve) => { finishSwitch = resolve; });
      activeWorkspaceId = workspaceId; return true; };
    activeWorkspaceId = 'current-workspace';
    const oldSwitch = start();
    await switching;
    scope = { userId: 'third-user', sessionId: 'third-session', epoch: 3 };
    finishSwitch(); await oldSwitch;
    assert.equal(opens.length, 0, 'auth change while switching cannot open or publish an old review URL');
    switchWorkspace = async (workspaceId) => { switches.push(workspaceId); activeWorkspaceId = workspaceId; return true; };
  }
}

async function main() {
  await verifyDelayedNotificationNavigation();
  const { fireEvent, render } = await import('@testing-library/react');
  let enabled = false;
  let ready = true;
  const opened: string[] = [];
  const availability = () => ({ documentReviewEnabled: enabled, ready, updatedAt: null, applyAvailability: () => {} });
  const toolbar = await compile<typeof Toolbar>('app/components/file-browser/FileToolbar.tsx', {
    'next-intl': { useTranslations: translate },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/components/ui/button': { Button },
    '@/components/ui/dropdown-menu': { DropdownMenu: passthrough, DropdownMenuContent: passthrough, DropdownMenuLabel: passthrough,
      DropdownMenuSeparator: () => <hr />, DropdownMenuTrigger: passthrough,
      DropdownMenuItem: ({ children, onSelect, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {onSelect?: () => void}) => <button {...props} onClick={onSelect}>{children}</button> },
    '@/components/ui/tooltip': { Tooltip: passthrough, TooltipContent: () => null, TooltipProvider: passthrough, TooltipTrigger: passthrough },
    '@/app/components/workspaces/WorkspaceSwitcher': { WorkspaceSwitcher: () => null, useShouldShowWorkspaceSwitcher: () => false },
    '@/app/store/file-store': { useFileStore: (selector: (state: {browserMode: string; setBrowserMode: () => void}) => unknown) => selector({ browserMode: 'tree', setBrowserMode: () => {} }) },
    '@/app/store/workspace-store': { useWorkspaceStore: (selector: (state: {activeWorkspaceId: string}) => unknown) => selector({ activeWorkspaceId: 'workspace-gating' }) },
    '@/app/store/workspace-operation-review-store': { openWorkspaceOperationReviewList: (workspaceId: string) => opened.push(workspaceId) },
    '@/app/components/file-version-center/DocumentReviewAvailabilityProvider': { useDocumentReviewAvailability: availability },
  });
  const handlers: Toolbar.FileToolbarHandlers = { onToggleMultiSelect() {}, onNewFile() {}, onNewExcalidraw() {}, onNewFolder() {},
    onUpload() {}, onDelete() {}, onCollapseAll() {}, onRefresh() {} };
  const label = messages.workspaceOperationReview.toolbarLabel;
  for (const variant of ['sidebar', 'mobile-sheet', 'fullscreen'] as const) {
    enabled = false; ready = true;
    const screen = render(<toolbar.FileToolbar variant={variant} isMultiSelectMode={false} isDeleteDisabled={false} handlers={handlers} />);
    assert.equal(screen.queryByRole('button', { name: label }), null, `${variant} hides Review Center when disabled`);
    assert.ok(screen.getAllByRole('button', { name: messages.notebook.newFolder }).length, 'ordinary file controls remain available');
    enabled = true; ready = false;
    screen.rerender(<toolbar.FileToolbar variant={variant} isMultiSelectMode={false} isDeleteDisabled={false} handlers={handlers} />);
    assert.equal(screen.queryByRole('button', { name: label }), null, 'unready availability cannot expose the experiment');
    ready = true;
    screen.rerender(<toolbar.FileToolbar variant={variant} isMultiSelectMode={false} isDeleteDisabled={false} handlers={handlers} />);
    fireEvent.click(screen.getAllByRole('button', { name: label })[0]);
    assert.equal(opened.at(-1), 'workspace-gating');
    enabled = false;
    screen.rerender(<toolbar.FileToolbar variant={variant} isMultiSelectMode={false} isDeleteDisabled={false} handlers={handlers} />);
    assert.equal(screen.queryByRole('button', { name: label }), null, 'live disable removes the review affordance');
    screen.unmount();
  }

  const applied: unknown[] = [];
  const requests: RequestInit[] = [];
  let status = 200;
  let payload: unknown = { success: true, data: { documentReviewEnabled: true, updatedAt: '2026-10-03T12:00:00Z' } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { assert.equal(url, '/api/admin/experimental-settings'); requests.push(init!); return Response.json(payload, { status }); };
  const settings = await compile<typeof Settings>('app/components/settings/ExperimentalFeaturesSettingsPanel.tsx', {
    'next-intl': { useTranslations: translate }, 'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/app/components/settings/TerminalSettingsCard': { TerminalSettingsCard: () => null },
    '@/app/components/settings/StudioBulkSettingsCard': { StudioBulkSettingsCard: () => null },
    '@/components/ui/card': { Card: passthrough, CardContent: passthrough, CardDescription: passthrough, CardHeader: passthrough, CardTitle: passthrough },
    '@/components/ui/switch': { Switch: ({ onCheckedChange, ...props }: React.InputHTMLAttributes<HTMLInputElement> & {onCheckedChange: (checked: boolean) => void}) =>
      <input type="checkbox" role="switch" {...props} onChange={(event) => onCheckedChange(event.target.checked)} /> },
    '@/app/components/file-version-center/DocumentReviewAvailabilityProvider': { useDocumentReviewAvailability: () => ({ ...availability(), applyAvailability: (value: unknown) => applied.push(value) }) },
  });
  try {
    enabled = false; ready = true;
    const screen = render(<settings.ExperimentalFeaturesSettingsPanel />);
    assert.ok(screen.getByText(/links.*automatically/u), 'settings explains mandatory link maintenance separately from the experiment');
    assert.ok(screen.getByText(/Errors appear in Notification Center/u));
    const control = screen.getByRole('switch') as HTMLInputElement;
    assert.equal(control.id, 'document-review-enabled');
    fireEvent.click(control);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(JSON.parse(String(requests.at(-1)?.body)), { documentReviewEnabled: true });
    assert.equal(requests.at(-1)?.credentials, 'include');
    assert.equal(applied.length, 1);
    status = 403; payload = { success: false, data: { documentReviewEnabled: true }, error: 'Forbidden' };
    fireEvent.click(control);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(applied.length, 1, 'a denied save cannot enable the experiment optimistically');
    assert.ok(screen.getByRole('alert'));
    ready = false; screen.rerender(<settings.ExperimentalFeaturesSettingsPanel />);
    assert.equal(control.disabled, true);
    screen.unmount();
    const parentSource = await fs.readFile('app/components/settings/IntegrationsSettingsClient.tsx', 'utf8');
    assert.match(parentSource, /isAdmin && renderLazyTabContent\('experimental'/u, 'the settings surface remains administrator-only');
  } finally { globalThis.fetch = originalFetch; }

  let centerCloses = 0;
  let pathCloses = 0;
  class Stream {
    onmessage: ((event: {data: string}) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) { streams.push(this); }
    close() { this.closed = true; }
  }
  const streams: Stream[] = [];
  const provider = await compile<typeof Availability>('app/components/file-version-center/DocumentReviewAvailabilityProvider.tsx', {
    '@/app/lib/auth-client': { authClient: { useSession: () => ({ data: { user: { id: 'admin-user' } } }) } },
    '@/app/lib/live-events/client': { LiveEventSource: Stream },
    '@/app/store/file-version-center-store': { closeVersionCenter: () => { centerCloses++; } },
    '@/app/store/workspace-operation-review-store': { closeWorkspaceOperationReview: () => { pathCloses++; } },
  });
  function Consumer() {
    const current = React.useContext(provider.DocumentReviewAvailabilityContext);
    return <p>{current.ready ? current.documentReviewEnabled ? 'enabled' : 'disabled' : 'loading'}</p>;
  }
  const screen = render(<provider.DocumentReviewAvailabilityProvider><Consumer /></provider.DocumentReviewAvailabilityProvider>);
  assert.ok(screen.getByText('loading'));
  const stream = streams.at(-1)!;
  await act(async () => stream.onmessage?.({ data: JSON.stringify({ documentReviewEnabled: true, updatedAt: '2026-10-03T12:00:00Z' }) }));
  assert.ok(screen.getByText('enabled'));
  await act(async () => stream.onmessage?.({ data: JSON.stringify({ documentReviewEnabled: false, updatedAt: '2026-10-03T12:00:01Z' }) }));
  assert.ok(screen.getByText('disabled'));
  assert.ok(centerCloses > 0 && pathCloses > 0, 'disabling closes both document and file-action review lanes');
  await act(async () => stream.onmessage?.({ data: JSON.stringify({ documentReviewEnabled: true, updatedAt: '2026-10-03T12:00:00Z' }) }));
  assert.ok(screen.getByText('disabled'), 'older availability cannot reopen the experiment');
  await act(async () => stream.onerror?.());
  assert.ok(screen.getByText('loading'), 'connection loss removes availability until refreshed');
  screen.unmount(); assert.equal(stream.closed, true); dom.window.close();
  console.log('review gating UI: all toolbar variants, readiness, nonoptimistic admin settings, localized core behavior and both review lanes passed');
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
