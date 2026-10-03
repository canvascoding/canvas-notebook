import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.example.test' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const { render, renderHook, waitFor, cleanup } = await import('@testing-library/react');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { SkillReferenceChipRow, useSkillReferenceCatalog } = await import('../app/components/canvas-agent-chat/SkillReferenceChips');
  const originalFetch = globalThis.fetch;
  const originalWorkspace = useWorkspaceStore.getState().activeWorkspaceId;
  const requests: URL[] = [];
  let version = 'initial';
  let delayedWorkspace: string | undefined;
  let delayedBody: Promise<void> | undefined;
  let waitingBodies = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input), 'https://canvas.example.test');
    assert.ok(['/api/plugins', '/api/skills'].includes(url.pathname));
    const workspaceId = url.searchParams.get('workspaceId');
    assert.ok(workspaceId, 'reference queries explicitly identify their active workspace');
    requests.push(url);
    const body = {
      success: true,
      plugins: [{ name: 'shared-package', version, description: workspaceId, enabled: true,
        resourceId: `organization:plugin:${workspaceId}`, scopeType: 'organization',
        interface: { displayName: 'Organization package', icon: 'assets/organization.svg' } },
      { name: 'disabled-personal', version: '9.0.0', description: 'Personal package', enabled: false,
        resourceId: 'personal:disabled', scopeType: 'user' }],
      skills: [{ name: 'shared-skill', title: 'Organization skill', description: workspaceId, enabled: true,
        resourceId: `organization:skill:${workspaceId}`, scopeType: 'organization' },
      { name: 'disabled-skill', title: 'Disabled', description: 'Disabled skill', enabled: false }],
    };
    const wait = workspaceId === delayedWorkspace ? delayedBody : undefined;
    return { ok: true, json: async () => {
      if (wait) { waitingBodies += 1; await wait; }
      return body;
    } } as Response;
  };
  useWorkspaceStore.setState({ activeWorkspaceId: null });
  const view = renderHook(() => useSkillReferenceCatalog());
  const peer = renderHook(() => useSkillReferenceCatalog());
  const row = render(<SkillReferenceChipRow content="/shared-package /shared-skill" />);
  const switchWorkspace = async (workspaceId: string | null) => {
    await act(async () => { useWorkspaceStore.setState({ activeWorkspaceId: workspaceId }); });
  };
  const expectWorkspace = async (workspaceId: string, expectedVersion: string) => {
    await waitFor(() => {
      for (const catalog of [view.result.current, peer.result.current]) {
        assert.equal(catalog.size, 2, 'disabled capabilities remain excluded');
        const plugin = catalog.get('shared-package');
        assert.ok(plugin?.kind === 'plugin');
        assert.equal(plugin.scopeType, 'organization');
        assert.equal(plugin.resourceId, `organization:plugin:${workspaceId}`);
        assert.equal(plugin.workspaceId, workspaceId);
        assert.equal(plugin.version, expectedVersion);
        const skill = catalog.get('shared-skill');
        assert.equal(skill?.scopeType, 'organization');
        assert.equal(skill?.resourceId, `organization:skill:${workspaceId}`);
        assert.equal(skill?.workspaceId, workspaceId);
      }
      const icon = row.container.querySelector('img');
      assert.ok(icon, 'the actual reference row renders its organization plugin icon');
      const iconUrl = new URL(icon.getAttribute('src')!, 'https://canvas.example.test');
      assert.equal(iconUrl.pathname, '/api/plugins/asset');
      assert.equal(iconUrl.searchParams.get('scope'), 'organization');
      assert.equal(iconUrl.searchParams.get('resourceId'), `organization:plugin:${workspaceId}`);
      assert.equal(iconUrl.searchParams.get('workspaceId'), workspaceId);
    });
  };
  try {
    assert.equal(view.result.current.size, 0);
    assert.equal(row.container.textContent, '');
    assert.equal(requests.length, 0, 'unhydrated workspace state does not start an unscoped capability query');
    await switchWorkspace('workspace-a');
    await expectWorkspace('workspace-a', 'initial');
    assert.equal(requests.length, 2, 'multiple hooks and chip rows share the current workspace request');

    let releaseB!: () => void;
    delayedWorkspace = 'workspace-b';
    delayedBody = new Promise<void>(resolve => { releaseB = resolve; });
    await switchWorkspace('workspace-b');
    await waitFor(() => assert.equal(waitingBodies, 2));
    assert.equal(view.result.current.size, 0, 'the new workspace immediately hides the preceding workspace catalog');
    assert.equal(peer.result.current.size, 0);
    assert.equal(row.container.textContent, '', 'old organization chips and icons disappear while the new catalog loads');
    await act(async () => { releaseB(); });
    await expectWorkspace('workspace-b', 'initial');
    assert.equal(requests.length, 4);

    let releaseA!: () => void;
    delayedWorkspace = 'workspace-a'; version = 'obsolete';
    delayedBody = new Promise<void>(resolve => { releaseA = resolve; });
    await switchWorkspace('workspace-a');
    await waitFor(() => assert.equal(waitingBodies, 4));
    assert.equal(requests.length, 6, 'returning to a workspace reloads its current capabilities instead of reusing old global references');
    await switchWorkspace('workspace-b');
    await expectWorkspace('workspace-b', 'obsolete');
    delayedWorkspace = undefined; version = 'fresh';
    await switchWorkspace('workspace-a');
    await expectWorkspace('workspace-a', 'fresh');
    assert.equal(requests.length, 10);
    await act(async () => { releaseA(); await new Promise(resolve => setTimeout(resolve, 0)); });
    await expectWorkspace('workspace-a', 'fresh');
    const remounted = renderHook(() => useSkillReferenceCatalog());
    await waitFor(() => {
      const plugin = remounted.result.current.get('shared-package');
      assert.ok(plugin?.kind === 'plugin');
      assert.equal(plugin.version, 'fresh', 'late old A JSON cannot poison the current A cache');
    });
    assert.equal(requests.length, 10, 'a new same-workspace consumer reuses only the current generation');
    remounted.unmount();
    await switchWorkspace(null);
    assert.equal(view.result.current.size, 0);
    assert.equal(row.container.textContent, '');
    version = 'after-clear';
    await switchWorkspace('workspace-a');
    await expectWorkspace('workspace-a', 'after-clear');
    assert.equal(requests.length, 12, 'clearing workspace state also clears the shared reference cache');
    view.unmount(); peer.unmount(); row.unmount();
    await switchWorkspace('workspace-b');
    await switchWorkspace('workspace-a');
    version = 'after-unmount';
    const reopened = renderHook(() => useSkillReferenceCatalog());
    await waitFor(() => {
      const plugin = reopened.result.current.get('shared-package');
      assert.ok(plugin?.kind === 'plugin');
      assert.equal(plugin.version, 'after-unmount', 'unmounted consumers leave no global workspace references for a later chat');
    });
    assert.equal(requests.length, 14);
    reopened.unmount();
    console.log('PASS reference chip scope: shared requests, exact organization icons, workspace isolation and late A-B-A JSON');
  } finally {
    cleanup(); globalThis.fetch = originalFetch;
    useWorkspaceStore.setState({ activeWorkspaceId: originalWorkspace });
    dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
