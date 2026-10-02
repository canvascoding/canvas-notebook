import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'getComputedStyle'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  const { ManagedSecretsInfo } = await import('../app/components/settings/ManagedSecretsInfo');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { WORKSPACE_ID_HEADER } = await import('../app/lib/workspaces/constants');
  const originalFetch = globalThis.fetch;
  const originalWorkspace = useWorkspaceStore.getState();
  const requests: Array<{ url: string; workspace: string | null; signal?: AbortSignal | null }> = [];
  let ownGemini = false;
  let brokenSearch = false;
  let deferredComposio: ((response: Response) => void) | undefined;
  const workspace = (id: string) => ({ id, name: id, type: 'personal' as const, color: '#2563EB' as const, status: 'active' as const, permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } });
  useWorkspaceStore.setState({ workspaces: [workspace('a'), workspace('b')], activeWorkspaceId: 'a', hydrateWorkspaces: async () => undefined });
  globalThis.fetch = async (input, init) => {
    assert.ok(!init?.method || init.method === 'GET', 'informational access checks never write secrets');
    const url = String(input);
    const active = new Headers(init?.headers).get(WORKSPACE_ID_HEADER);
    requests.push({ url, workspace: active, signal: init?.signal });
    if (url === '/api/composio/status') {
      if (active === 'a') return new Promise<Response>(resolve => { deferredComposio = resolve; });
      return Response.json({ mode: 'managed', configured: true, apiKeyValid: true, providerHealthy: false, accessToken: 'must-never-render' });
    }
    if (url === '/api/integrations/search/status') return brokenSearch
      ? Response.json({ error: 'sensitive-provider-debug-must-not-render' }, { status: 503 })
      : Response.json({ success: true, data: { mode: 'local', provider: 'ollama' } });
    if (url === '/api/studio/config') return Response.json({ success: true, config: { localApiKeys: { gemini: ownGemini, openai: false, kie: false }, managedMediaAvailable: true, apiKey: 'must-never-render' } });
    assert.ok(url.startsWith('/api/agent-runtime/effective?workspaceId='));
    return Response.json({ success: true, data: { effectiveSelection: { credentialScope: 'managed' }, valid: true } });
  };

  try {
    const view = render(<ManagedSecretsInfo language="en" />);
    await waitFor(() => assert.ok(deferredComposio));
    assert.equal(document.querySelector('details')?.open, false, 'service details start closed');
    assert.ok(document.querySelector('[role="status"]')?.textContent?.includes('Checking'));
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'b' }));
    await waitFor(() => assert.ok(document.querySelector('[role="status"]')?.textContent?.includes('Through Control Plane')));
    assert.ok(document.querySelector('[data-testid="managed-access-search"]')?.textContent?.includes('Ollama'));
    assert.ok(document.querySelector('[data-testid="managed-access-search"]')?.textContent?.includes('Own credentials'), 'a local Ollama choice never appears as managed Brave');
    assert.ok(document.querySelector('[data-testid="managed-access-composio"]')?.textContent?.includes('Check access'), 'a managed outage does not look healthy');
    assert.ok(requests.some(request => request.workspace === 'b'), 'Composio uses the active workspace header');
    assert.ok(requests.some(request => request.url.endsWith('workspaceId=b')), 'AI selection uses the active workspace');
    assert.ok(requests.find(request => request.workspace === 'a')?.signal?.aborted);
    await act(async () => { deferredComposio!(Response.json({ mode: 'local' })); });
    assert.ok(document.querySelector('[data-testid="managed-access-composio"]')?.textContent?.includes('Control Plane'), 'a late response from the previous workspace cannot replace the current source');

    ownGemini = true;
    brokenSearch = true;
    await act(async () => window.dispatchEvent(new CustomEvent('canvas_secrets_updated')));
    await waitFor(() => assert.ok(document.querySelector('[data-testid="managed-access-gemini"]')?.textContent?.includes('Own credentials')));
    assert.ok(document.querySelector('[data-testid="managed-access-search"]')?.textContent?.includes('Unconfirmed'));
    assert.ok(document.querySelector('[role="status"]')?.textContent?.includes('Some access sources'));
    assert.equal(document.querySelector('input, textarea'), null, 'managed access has no value editor or reveal control');
    assert.equal(document.body.textContent?.includes('must-never-render'), false);
    assert.equal(document.body.textContent?.includes('sensitive-provider-debug'), false);

    brokenSearch = false;
    await act(async () => fireEvent.click(view.getByRole('button', { name: 'Reload access sources' })));
    await waitFor(() => assert.ok(document.querySelector('[data-testid="managed-access-search"]')?.textContent?.includes('Own credentials')));
    view.rerender(<ManagedSecretsInfo language="de" />);
    assert.ok(document.body.textContent?.includes('Eigene Zugangsdaten'));
    assert.ok(document.body.textContent?.includes('Dienste und Zugriffsquellen'));
    assert.equal(document.querySelector('details')?.open, false);
    console.log('managed-secrets-info-test: PASS (read-only sources, local precedence, outages, scoped requests, late responses, save refresh and localization)');
  } finally {
    cleanup();
    useWorkspaceStore.setState(originalWorkspace);
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
