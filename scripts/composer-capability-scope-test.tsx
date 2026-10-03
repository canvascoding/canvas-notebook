import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.example.test' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const { renderHook, waitFor, cleanup } = await import('@testing-library/react');
  const { useComposerReferences } = await import('../app/components/canvas-agent-chat/useComposerReferences');
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let delayedBody: Promise<void> | undefined;
  let delayedWorkspace: string | undefined;
  let currentVersion = 'current';
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'https://canvas.example.test');
    requests.push(url.href);
    const workspaceId = url.searchParams.get('workspaceId');
    assert.ok(workspaceId, 'capability queries carry the current workspace');
    const plugin = { name: 'shared-package', version: currentVersion, enabled: true,
      scopeType: 'organization', resourceId: `org:${workspaceId}`, description: workspaceId, skills: [] };
    const skills = [{ name: 'shared-skill', title: 'Shared skill', enabled: true, core: false,
      scopeType: 'organization', resourceId: `org-skill:${workspaceId}`, description: workspaceId }];
    const body = { success: true, plugins: [plugin], skills };
    const wait = workspaceId === delayedWorkspace ? delayedBody : undefined;
    return { ok: true, headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => { await wait; return JSON.stringify(body); } } as Response;
  };
  const view = renderHook(({ workspaceId }) => useComposerReferences({
    agentId: 'canvas-agent', input: '/', workspaceId,
    resetInputHistoryNavigation: () => {}, setInput: () => {},
    textareaRef: { current: null },
  }), { initialProps: { workspaceId: 'workspace-a' } });
  const open = async () => {
    await act(async () => view.result.current.handleInputChange({ target: { value: '/', selectionStart: 1 } } as React.ChangeEvent<HTMLTextAreaElement>));
  };
  const expectWorkspace = async (workspaceId: string) => {
    await waitFor(() => {
      assert.equal(view.result.current.isLoadingReferenceItems, false);
      assert.equal(view.result.current.referencePickerError, null);
      assert.equal(view.result.current.referencePickerItems.length, 2);
      const plugin = view.result.current.referencePickerItems.find((item) => item.kind === 'plugin')!;
      assert.equal((plugin.payload as { name: string; resourceId?: string }).resourceId, `org:${workspaceId}`);
      assert.equal((plugin.payload as { name: string; scopeType?: string }).scopeType, 'organization');
      const skill = view.result.current.referencePickerItems.find((item) => item.kind === 'skill')!;
      assert.equal((skill.payload as { name: string; resourceId?: string }).resourceId, `org-skill:${workspaceId}`);
    });
  };
  try {
    await open(); await expectWorkspace('workspace-a');
    assert.equal(requests.length, 2);
    await open(); await expectWorkspace('workspace-a');
    assert.equal(requests.length, 2, 'same-workspace picker reuses its own cache');
    view.rerender({ workspaceId: 'workspace-b' });
    await open(); await expectWorkspace('workspace-b');
    assert.equal(requests.length, 4, 'workspace switch invalidates both capability caches');

    let release!: () => void;
    delayedBody = new Promise<void>((resolve) => { release = resolve; });
    delayedWorkspace = 'workspace-a'; currentVersion = 'obsolete';
    view.rerender({ workspaceId: 'workspace-a' });
    await open();
    await waitFor(() => assert.equal(requests.length, 6));
    view.rerender({ workspaceId: 'workspace-b' });
    view.rerender({ workspaceId: 'workspace-a' });
    delayedWorkspace = undefined; currentVersion = 'fresh';
    await open(); await expectWorkspace('workspace-a');
    await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const plugin = view.result.current.referencePickerItems.find((item) => item.kind === 'plugin')!;
    assert.equal((plugin.payload as { version: string }).version, 'fresh', 'late A JSON cannot overwrite the new A generation');
    await open(); await expectWorkspace('workspace-a');
    assert.equal(requests.length, 8, 'obsolete JSON cannot poison the current cache');
    console.log('Composer capability scope: organization identities, scoped caches, workspace invalidation and late A-B-A JSON passed.');
  } finally {
    cleanup(); globalThis.fetch = originalFetch; dom.window.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
