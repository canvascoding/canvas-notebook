import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import * as React from 'react';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

import type * as StudioUi from '../app/apps/studio/components/create/SaveToWorkspaceDialog';
import type * as EmailUi from '../app/apps/email/components/EmailAttachmentActions';
import type { WorkspaceDestinationPicker } from '../app/components/workspaces/WorkspaceDestinationPicker';

type PickerProps = React.ComponentProps<typeof WorkspaceDestinationPicker>;
type Preview = { path: string; name: string; mediaUrl: string; previewUrl: string; mode: 'crop';
  width: number; height: number; mimeType: string };
type CopyProps = { open: boolean; onOpenChange: (open: boolean) => void; preview: Preview | null; onCopied: (path: string) => void };
type EmailProps = React.ComponentProps<typeof EmailUi.EmailAttachmentActions>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const preview = (name: string): Preview => ({ path: `studio/previews/${name}`, name, mediaUrl: '/synthetic.png',
  previewUrl: '/synthetic-preview.png', mode: 'crop', width: 1024, height: 1024, mimeType: 'image/png' });
const labels: EmailProps['labels'] = {
  attachmentActions: 'Attachment actions', attachmentUnavailable: 'Unavailable', attachments: 'Attachments',
  attachmentsSaveFailed: 'Save failed', attachmentsSaved: '{count} attachments saved', cancel: 'Cancel',
  downloadAllAttachments: 'Download all', downloadAttachment: 'Download', downloadLocally: 'Download locally',
  saveAttachmentsDescription: 'Save {count} attachments', saveAttachmentsSubmit: 'Save attachments',
  saveAttachmentsTitle: 'Save attachments to workspace', saveToWorkspace: 'Save to workspace',
  savingAttachments: 'Saving attachments', unknownAttachmentType: 'Unknown type',
};
const attachments: EmailProps['attachments'] = [
  { id: 'attachment-one', filename: 'report.pdf', contentType: 'application/pdf', size: 2048 },
  { id: 'attachment-two', filename: 'data.csv', contentType: 'text/csv', size: 1024 },
];

async function compileAdapters() {
  const controls = {
    activeWorkspaceId: 'source', picker: null as PickerProps | null,
    requests: [] as Array<{ url: string; body: Record<string, unknown>; headers: Headers; credentials?: RequestCredentials }>,
    refreshes: [] as Array<[string, boolean | undefined, string | null | undefined]>,
    successes: [] as string[], errors: [] as string[],
    response: async () => Response.json({ success: true, savedCount: 2, path: 'Projects/Reports/result.png' }),
    refresh: async () => undefined as void,
  };
  const workspaces = ['source', 'second-source', 'foreign'].map((id) => ({ id, permissions: { canWrite: true } }));
  const workspaceState = () => ({ activeWorkspaceId: controls.activeWorkspaceId, workspaces });
  const useWorkspaceStore = Object.assign((selector: (state: ReturnType<typeof workspaceState>) => unknown) => selector(workspaceState()),
    { getState: workspaceState });
  const fileState = { refreshDirectory: async (dir: string, noCache?: boolean, workspaceId?: string | null) => {
    controls.refreshes.push([dir, noCache, workspaceId]);
    await controls.refresh();
  } };
  const useFileStore = Object.assign((selector?: (state: typeof fileState) => unknown) => selector ? selector(fileState) : fileState,
    { getState: () => fileState });
  const translators = new Map<string, (key: string) => string>();
  const passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
  const icon = () => null;
  const mocks: Record<string, unknown> = {
    'lucide-react': new Proxy({}, { get: () => icon }),
    'next-intl': { useTranslations: (namespace: string) => {
      if (!translators.has(namespace)) translators.set(namespace, (key) => key);
      return translators.get(namespace)!;
    } },
    'next/navigation': { useSearchParams: () => new URLSearchParams() },
    'sonner': { toast: { success: (message: string) => controls.successes.push(message), error: (message: string) => controls.errors.push(message) } },
    '@/app/store/workspace-store': { useWorkspaceStore,
      selectActiveWorkspace: (state: ReturnType<typeof workspaceState>) =>
        state.workspaces.find((item) => item.id === state.activeWorkspaceId) },
    '@/app/store/file-store': { useFileStore },
    '@/app/components/workspaces/WorkspaceDestinationPicker': {
      WorkspaceDestinationPicker: (props: PickerProps) => { controls.picker = props; return <div data-testid="destination-picker" />; },
    },
    '@/components/ui/button': { Button: function TestButton({ children, variant: _variant, size: _size, ...props }:
      React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) {
      return <button type="button" {...props}>{children}</button>;
    } },
    '@/components/ui/input': { Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> },
    '@/components/ui/dialog': {
      Dialog: ({ open, onOpenChange, children }: React.PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>) => open ? <>
        <button type="button" data-testid="dialog-dismiss" onClick={() => onOpenChange(false)}>Dismiss dialog</button>{children}</> : null,
      DialogContent: ({ children }: React.PropsWithChildren) => <section role="dialog">{children}</section>,
      DialogHeader: passthrough, DialogFooter: passthrough, DialogDescription: passthrough, DialogTitle: passthrough,
    },
    '@/components/ui/dropdown-menu': {
      DropdownMenu: passthrough, DropdownMenuContent: passthrough, DropdownMenuTrigger: passthrough,
      DropdownMenuItem: ({ children, onSelect, asChild }: React.PropsWithChildren<{ onSelect?: () => void; asChild?: boolean }>) =>
        asChild ? <>{children}</> : <button type="button" role="menuitem" onClick={onSelect}>{children}</button>,
    },
    '@/components/ui/alert-dialog': new Proxy({}, { get: () => passthrough }),
    '@/components/ui/switch': { Switch: () => null },
    '@/lib/utils': { cn: (...parts: string[]) => parts.filter(Boolean).join(' ') },
    '@/app/apps/studio/components/create/ReferencePickerDialog': { ReferencePickerDialog: () => null },
    '@/app/apps/studio/context/studio-chat-context': { useSetStudioChatContext: () => () => undefined },
    '@/app/lib/integrations/image-generation-constants': {},
    '@/app/lib/utils/media-url': {},
    '@/app/lib/email/attachment-preview': { inboundEmailAttachmentPreviewItems: ({ attachments: items }: { attachments: EmailProps['attachments'] }) =>
      items.map((item) => ({ id: item.id })) },
    './useEmailAttachmentPreview': { useEmailAttachmentPreview: () => ({ canOpen: false,
      openLabel: (name: string) => `Preview ${name}`, openAttachment: () => undefined, dialog: null }) },
  };
  const compile = async (relative: string, expose = '') => {
    const filename = path.resolve(relative);
    const load = createRequire(filename);
    const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const exports: Record<string, unknown> = {};
    new Function('require', 'module', 'exports', source + expose)(
      (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports);
    return exports;
  };
  mocks['../../utils/studio-api'] = await compile('app/apps/studio/utils/studio-api.ts');
  const studio = await compile('app/apps/studio/components/create/SaveToWorkspaceDialog.tsx') as typeof StudioUi;
  const copy = await compile('app/apps/studio/components/aspect-ratio/AspectRatioEditorView.tsx',
    '\nexports.WorkspaceCopyDialog = WorkspaceCopyDialog;') as { WorkspaceCopyDialog: React.ComponentType<CopyProps> };
  const email = await compile('app/apps/email/components/EmailAttachmentActions.tsx') as typeof EmailUi;
  return { controls, ...studio, ...copy, ...email };
}

async function withAdapters(run: (fixture: {
  ui: Awaited<ReturnType<typeof compileAdapters>>;
  render: (element: React.ReactNode) => Promise<void>;
  flush: () => Promise<void>;
  button: (name: string, index?: number) => HTMLButtonElement;
  fireEvent: typeof import('@testing-library/react')['fireEvent'];
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'] as const;
  const prior = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names) {
    if (name !== 'fetch') Object.defineProperty(globalThis, name, { configurable: true, writable: true,
      value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[name] });
  }
  const { createRoot } = await import('react-dom/client');
  const { fireEvent } = await import('@testing-library/react');
  const root = createRoot(document.getElementById('root')!);
  const ui = await compileAdapters();
  globalThis.fetch = async (url, init) => {
    ui.controls.requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')),
      headers: new Headers(init?.headers), credentials: init?.credentials });
    return ui.controls.response();
  };
  const button = (name: string, index = 0) => {
    const value = [...document.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent?.trim() === name)[index];
    assert.ok(value, `button ${name} is visible`);
    return value;
  };
  const flush = async () => {
    for (let index = 0; index < 3; index += 1) await act(async () => { await new Promise<void>((done) => setImmediate(done)); });
  };
  try { await run({ ui, button, flush, fireEvent, render: async (element) => { await act(async () => root.render(element)); } }); }
  finally {
    await act(async () => root.unmount());
    dom.window.close();
    names.forEach((name, index) => {
      if (prior[index]) Object.defineProperty(globalThis, name, prior[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

function assertRequestContext(request: { headers: Headers; credentials?: RequestCredentials }, sourceWorkspaceId?: string) {
  assert.equal(request.headers.get('Content-Type'), 'application/json');
  assert.equal(request.headers.get('x-canvas-workspace-id'), sourceWorkspaceId ?? null);
  assert.equal(request.credentials, 'include');
}

test('Studio output save waits for folder creation and preserves output IDs, nested foreign target and source headers', async () => {
  await withAdapters(async ({ ui, render, button, flush }) => {
    const closed: boolean[] = [];
    let imported = 0;
    await render(<ui.SaveToWorkspaceDialog open outputIds={['output-one', 'output-two']}
      onOpenChange={(value) => closed.push(value)} onImported={() => { imported += 1; }} />);
    await act(async () => {
      ui.controls.picker!.onWorkspaceChange('foreign'); ui.controls.picker!.onDirChange('Projects/Reports');
      ui.controls.picker!.onCreatingDirectoryChange?.(true);
    });
    assert.equal(button('submit').disabled, true);
    assert.equal(button('cancel').disabled, true);
    await act(async () => { button('submit').click(); button('cancel').click(); button('Dismiss dialog').click(); });
    assert.deepEqual(ui.controls.requests, []);
    assert.deepEqual(closed, [], 'closing is blocked while the selected folder is being created');
    await act(async () => ui.controls.picker!.onCreatingDirectoryChange?.(false));
    await act(async () => button('submit').click());
    await flush();
    assert.equal(ui.controls.requests[0].url, '/api/studio/outputs/save-to-workspace');
    assert.deepEqual(ui.controls.requests[0].body, {
      outputIds: ['output-one', 'output-two'], targetPath: 'Projects/Reports', targetWorkspaceId: 'foreign',
    });
    assertRequestContext(ui.controls.requests[0], 'source');
    assert.deepEqual(ui.controls.refreshes, [], 'saving to a foreign workspace does not refresh the active file tree');
    assert.deepEqual(closed, [false]);
    assert.equal(imported, 1);
  });
});

test('aspect ratio copy waits for folder creation and preserves its filename, preview and foreign target', async () => {
  await withAdapters(async ({ ui, render, button, fireEvent, flush }) => {
    const closed: boolean[] = [];
    const copied: string[] = [];
    await render(<ui.WorkspaceCopyDialog open preview={preview('original.png')} onOpenChange={(value) => closed.push(value)}
      onCopied={(value) => copied.push(value)} />);
    await act(async () => {
      ui.controls.picker!.onWorkspaceChange('foreign'); ui.controls.picker!.onDirChange('Projects/Reports');
      fireEvent.change(document.querySelector('input')!, { target: { value: 'final-report.png' } });
      ui.controls.picker!.onCreatingDirectoryChange?.(true);
    });
    assert.equal(button('copy').disabled, true);
    assert.equal(button('cancel').disabled, true);
    assert.equal(document.querySelector<HTMLInputElement>('input')?.disabled, true);
    await act(async () => { button('copy').click(); button('cancel').click(); button('Dismiss dialog').click(); });
    assert.deepEqual(ui.controls.requests, []);
    assert.deepEqual(closed, []);
    await act(async () => ui.controls.picker!.onCreatingDirectoryChange?.(false));
    await act(async () => button('copy').click());
    await flush();
    assert.equal(ui.controls.requests[0].url, '/api/studio/aspect-ratio/save');
    assert.deepEqual(ui.controls.requests[0].body, { action: 'copy_workspace', previewPath: 'studio/previews/original.png',
      targetDirectory: 'Projects/Reports', targetWorkspaceId: 'foreign', fileName: 'final-report.png' });
    assertRequestContext(ui.controls.requests[0], 'source');
    assert.deepEqual(ui.controls.refreshes, []);
    assert.deepEqual(copied, ['Projects/Reports/result.png']);
    assert.deepEqual(closed, [false]);
  });
});

test('email attachment save waits for folder creation and preserves mailbox source, selected IDs and foreign target', async () => {
  await withAdapters(async ({ ui, render, button, flush }) => {
    await render(<ui.EmailAttachmentActions accountId="account/one" messageId="message:one" mailboxWorkspaceId="mailbox-source"
      folder="INBOX/Reports" attachments={attachments} labels={labels} />);
    await act(async () => button('Save to workspace').click());
    await act(async () => {
      ui.controls.picker!.onWorkspaceChange('foreign'); ui.controls.picker!.onDirChange('Projects/Reports');
      ui.controls.picker!.onCreatingDirectoryChange?.(true);
    });
    assert.equal(button('Save attachments').disabled, true);
    assert.equal(button('Cancel').disabled, true);
    await act(async () => { button('Save attachments').click(); button('Cancel').click(); button('Dismiss dialog').click(); });
    assert.deepEqual(ui.controls.requests, []);
    assert.ok(document.querySelector('[role="dialog"]'), 'creating a folder keeps the attachment save dialog open');
    await act(async () => ui.controls.picker!.onCreatingDirectoryChange?.(false));
    await act(async () => button('Save attachments').click());
    await flush();
    assert.equal(ui.controls.requests[0].url, '/api/email/accounts/account%2Fone/messages/message%3Aone/attachments');
    assert.deepEqual(ui.controls.requests[0].body, { mailboxWorkspaceId: 'mailbox-source',
      attachmentIds: ['attachment-one', 'attachment-two'], folder: 'INBOX/Reports',
      targetPath: 'Projects/Reports', targetWorkspaceId: 'foreign' });
    assertRequestContext(ui.controls.requests[0]);
    assert.deepEqual(ui.controls.refreshes, []);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.deepEqual(ui.controls.successes, ['2 attachments saved']);
  });
});

test('a stale Studio output save cannot refresh, close, or reset a newer save in another source context', async () => {
  await withAdapters(async ({ ui, render, button, flush }) => {
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    ui.controls.response = () => ui.controls.requests.length === 1 ? oldResponse.promise : newResponse.promise;
    const closed: boolean[] = [];
    let imported = 0;
    const props = { open: true, onOpenChange: (value: boolean) => closed.push(value), onImported: () => { imported += 1; } };
    await render(<ui.SaveToWorkspaceDialog {...props} outputIds={['old-output']} />);
    await act(async () => button('submit').click());
    ui.controls.activeWorkspaceId = 'second-source';
    await render(<ui.SaveToWorkspaceDialog {...props} outputIds={['new-output']} />);
    await flush();
    await act(async () => button('submit').click());
    assert.equal(ui.controls.requests.length, 2, 'a new context can start its own save');
    await act(async () => oldResponse.resolve(Response.json({ success: true, savedCount: 1 })));
    await flush();
    assert.deepEqual(ui.controls.refreshes, []);
    assert.deepEqual(closed, []);
    assert.equal(imported, 0);
    assert.equal(button('saving').disabled, true, 'the old finally block leaves the new request busy');
    assert.deepEqual(ui.controls.successes, []);
    await act(async () => newResponse.resolve(Response.json({ success: true, savedCount: 1 })));
    await flush();
    assertRequestContext(ui.controls.requests[0], 'source');
    assertRequestContext(ui.controls.requests[1], 'second-source');
    assert.deepEqual(ui.controls.requests[1].body, { outputIds: ['new-output'], targetPath: '.', targetWorkspaceId: 'second-source' });
    assert.deepEqual(ui.controls.refreshes, [['.', true, 'second-source']]);
    assert.deepEqual(closed, [false]);
    assert.equal(imported, 1);
  });
});

test('a stale aspect ratio copy cannot close or publish an old preview into a newer copy context', async () => {
  await withAdapters(async ({ ui, render, button, flush }) => {
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    ui.controls.response = () => ui.controls.requests.length === 1 ? oldResponse.promise : newResponse.promise;
    const closed: boolean[] = [];
    const copied: string[] = [];
    const props = { open: true, onOpenChange: (value: boolean) => closed.push(value), onCopied: (value: string) => copied.push(value) };
    await render(<ui.WorkspaceCopyDialog {...props} preview={preview('old.png')} />);
    await act(async () => button('copy').click());
    ui.controls.activeWorkspaceId = 'second-source';
    await render(<ui.WorkspaceCopyDialog {...props} preview={preview('new.png')} />);
    await flush();
    await act(async () => button('copy').click());
    assert.equal(ui.controls.requests.length, 2);
    await act(async () => oldResponse.resolve(Response.json({ success: true, path: 'old-copy.png' })));
    await flush();
    assert.deepEqual(ui.controls.refreshes, []);
    assert.deepEqual(closed, []);
    assert.deepEqual(copied, []);
    assert.equal(button('copy').disabled, true, 'the old request does not unlock the new copy');
    await act(async () => newResponse.resolve(Response.json({ success: true, path: 'new-copy.png' })));
    await flush();
    assertRequestContext(ui.controls.requests[0], 'source');
    assertRequestContext(ui.controls.requests[1], 'second-source');
    assert.deepEqual(ui.controls.requests[1].body, { action: 'copy_workspace', previewPath: 'studio/previews/new.png',
      targetDirectory: '.', targetWorkspaceId: 'second-source', fileName: 'new.png' });
    assert.deepEqual(ui.controls.refreshes, [['.', true, 'second-source']]);
    assert.deepEqual(copied, ['new-copy.png']);
    assert.deepEqual(closed, [false]);
  });
});

test('a stale mailbox save failure cannot disturb access or close a newer message attachment save', async () => {
  await withAdapters(async ({ ui, render, button, flush }) => {
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    ui.controls.response = () => ui.controls.requests.length === 1 ? oldResponse.promise : newResponse.promise;
    let accessChanged = 0;
    const props = { accountId: 'account', messageId: 'old-message', mailboxWorkspaceId: 'old-mailbox',
      folder: 'INBOX', attachments, labels, onMailboxAccessChanged: () => { accessChanged += 1; } };
    await render(<ui.EmailAttachmentActions {...props} />);
    await act(async () => button('Save to workspace').click());
    await act(async () => button('Save attachments').click());
    ui.controls.activeWorkspaceId = 'second-source';
    await render(<ui.EmailAttachmentActions {...props} messageId="new-message" mailboxWorkspaceId="new-mailbox" folder="Archive" />);
    await flush();
    await act(async () => button('Save to workspace').click());
    await act(async () => button('Save attachments').click());
    assert.equal(ui.controls.requests.length, 2);
    await act(async () => oldResponse.resolve(Response.json({ success: false, error: 'old mailbox denied' }, { status: 403 })));
    await flush();
    assert.equal(accessChanged, 0, 'old mailbox failure does not invalidate the current mailbox');
    assert.deepEqual(ui.controls.errors, []);
    assert.deepEqual(ui.controls.refreshes, []);
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.equal(button('Saving attachments').disabled, true, 'old finally leaves the new message request busy');
    await act(async () => newResponse.resolve(Response.json({ success: true, savedCount: 2 })));
    await flush();
    assert.equal(ui.controls.requests[1].url, '/api/email/accounts/account/messages/new-message/attachments');
    assert.deepEqual(ui.controls.requests[1].body, { mailboxWorkspaceId: 'new-mailbox',
      attachmentIds: ['attachment-one', 'attachment-two'], folder: 'Archive', targetPath: '.', targetWorkspaceId: 'second-source' });
    assert.deepEqual(ui.controls.refreshes, [['.', true, 'second-source']]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  });
});

test('Studio completion rechecks source context after a pending explicit workspace refresh', async () => {
  await withAdapters(async ({ ui, render, button, flush }) => {
    const pendingRefresh = deferred<void>();
    ui.controls.refresh = () => pendingRefresh.promise;
    const closed: boolean[] = [];
    let imported = 0;
    const props = { open: true, onOpenChange: (value: boolean) => closed.push(value), onImported: () => { imported += 1; } };
    await render(<ui.SaveToWorkspaceDialog {...props} outputIds={['old-output']} />);
    await act(async () => button('submit').click());
    await flush();
    assert.deepEqual(ui.controls.refreshes, [['.', true, 'source']], 'the successful request refreshes its captured workspace');
    ui.controls.activeWorkspaceId = 'second-source';
    await render(<ui.SaveToWorkspaceDialog {...props} outputIds={['new-output']} />);
    await act(async () => pendingRefresh.resolve());
    await flush();
    assert.deepEqual(closed, [], 'old completion cannot close a dialog reopened in the new source context');
    assert.equal(imported, 0);
    assert.deepEqual(ui.controls.successes, []);
    assert.equal(button('submit').disabled, false, 'the new context is usable after old refresh completion');
  });
});
