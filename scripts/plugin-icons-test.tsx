import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.example.test/plugins' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const { render, fireEvent, cleanup } = await import('@testing-library/react');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { CanvasPluginIcon } = await import('../app/lib/plugins/plugin-icons');
  const originalWorkspace = useWorkspaceStore.getState().activeWorkspaceId;
  const plugin = { name: 'same-name', scopeType: 'organization', resourceId: 'organization-resource', version: '1.0.0', interface: { displayName: 'Organization Plugin', icon: './assets/icon.svg', brandColor: '#2563EB' } };
  try {
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-one' });
    const view = render(<CanvasPluginIcon plugin={plugin} />);
    const currentImage = () => {
      const image = view.container.querySelector('img');
      assert.ok(image);
      return image;
    };
    const first = currentImage();
    const url = new URL(first.src);
    assert.equal(url.pathname, '/api/plugins/asset');
    assert.equal(url.searchParams.get('scope'), 'organization');
    assert.equal(url.searchParams.get('resourceId'), 'organization-resource');
    assert.equal(url.searchParams.get('workspaceId'), 'workspace-one');
    assert.equal(url.searchParams.get('path'), 'assets/icon.svg');
    assert.equal(url.searchParams.get('version'), '1.0.0');
    fireEvent.error(first);
    assert.equal(view.container.querySelector('img'), null);
    assert.equal(view.container.textContent, 'OP', 'failed assets keep the existing initials fallback');
    view.rerender(<CanvasPluginIcon plugin={{ ...plugin, resourceId: 'other-resource' }} />);
    const nextIdentityImage = currentImage();
    assert.notEqual(nextIdentityImage, first);
    assert.equal(new URL(nextIdentityImage.src).searchParams.get('resourceId'), 'other-resource', 'new resource identities retry a previously failed local icon');
    fireEvent.error(nextIdentityImage);
    await act(async () => { useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-two' }); });
    assert.equal(new URL(currentImage().src).searchParams.get('workspaceId'), 'workspace-two', 'workspace changes retry the asset in the current authorized context');
    view.rerender(<CanvasPluginIcon plugin={{ ...plugin, scopeType: 'user', resourceId: undefined }} />);
    assert.equal(new URL(currentImage().src).searchParams.get('scope'), 'user');
    assert.equal(new URL(currentImage().src).searchParams.has('resourceId'), false, 'unscoped legacy Chat callers retain the personal asset contract');
    view.rerender(<CanvasPluginIcon plugin={{ name: 'legacy-chat', interface: { displayName: 'Legacy Chat' } }} />);
    assert.equal(view.container.textContent, 'LC');
    view.rerender(<CanvasPluginIcon plugin={{ name: 'remote', interface: { icon: 'https://images.example.test/icon.png' } }} />);
    assert.equal(currentImage().src, 'https://images.example.test/icon.png');
    fireEvent.error(currentImage());
    view.rerender(<CanvasPluginIcon plugin={{ name: 'remote', interface: { icon: 'https://images.example.test/retry.png' } }} />);
    assert.equal(currentImage().src, 'https://images.example.test/retry.png', 'changed remote icon URLs also retry');
    console.log('Plugin icons: scoped resource/workspace URLs, identity changes after image failure, legacy Chat initials and remote assets passed.');
  } finally {
    cleanup();
    useWorkspaceStore.setState({ activeWorkspaceId: originalWorkspace });
    dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
