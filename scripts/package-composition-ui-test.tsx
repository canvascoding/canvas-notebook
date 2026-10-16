import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { PluginExtensionItem } from '../app/lib/plugins/plugin-extension-contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/en/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'MutationObserver', 'Event', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Mounted authoring UI with the genuine shared search hook and rows. Server authority is tested separately. */
async function main() {
  const loader = Module as typeof Module & { _load(name: string, parent: NodeModule | null, main: boolean): unknown };
  const original = loader._load, originalFetch = globalThis.fetch;
  loader._load = (name, parent, isMain) => name === '@/i18n/navigation' ? {
    Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) { return <a {...props} ref={ref} />; }),
  } : original(name, parent, isMain);
  const { render, screen, act, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  const actor = { user: { id: 'author', name: 'Author', email: 'author@fixture.invalid', role: 'admin', emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0), banned: false },
    session: { id: 'author-session', userId: 'author', token: 'CONTROLLED_SESSION', expiresAt: new Date('2099-01-01'), createdAt: new Date(0), updatedAt: new Date(0) } };
  const access = { canRead: true, canUse: false, canManage: false };
  const skill = { id: 'canvas-resource:source', kind: 'skill', name: 'source-review', displayName: 'Read-only source', description: 'Readable without Use', stock: 'installed', source: 'local', access,
    package: { resourceRef: 'canvas-resource:source' } } as PluginExtensionItem;
  const integration: PluginExtensionItem = { id: 'composio:hubspot', kind: 'integration', name: 'hubspot', displayName: 'HubSpot', description: 'CRM', stock: 'available', source: 'composio', access,
    toolkit: { slug: 'hubspot', noAuth: false }, connections: [] };
  const mcp: PluginExtensionItem = { id: 'mcp-definition:backend', kind: 'mcp', name: 'Research', displayName: 'Company Research', description: 'Search facts', stock: 'available', source: 'mcp', access,
    mcp: { definitionId: 'PRIVATE_BACKEND', transport: 'http', template: true }, connections: [] };
  const mutations: Array<{ path: string; body: Record<string, unknown> }> = [];
  const exact = { resourceRef: 'canvas-resource:source', revisionRef: 'canvas-package-revision:11111111-1111-4111-8111-111111111111', expectedChecksum: 'a'.repeat(64) };
  let searchCount = 0, sourceReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.origin);
    if (url.pathname === '/api/auth/get-session') return Response.json(actor);
    assert.equal(url.searchParams.get('workspaceId'), 'workspace');
    assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), 'workspace');
    if (url.pathname === '/api/plugins/search') {
      searchCount++;
      return Response.json({ success: true, data: { schemaVersion: 1, query: {}, items: [skill, integration, mcp], selectedItem: null,
        scopes: { choices: ['all'], teams: [] }, coverage: [{ source: 'packages', status: 'complete' }], pagination: { nextCursor: null, hasNextPage: false, loadedItems: 3 } } });
    }
    if (url.pathname.endsWith('/authoring-source') && ++sourceReads === 1) return Response.json({ success: false, code: 'PACKAGE_SNAPSHOT_UNAVAILABLE' }, { status: 503 });
    if (url.pathname.endsWith('/authoring-source')) return Response.json({ success: true, data: { source: exact,
      skills: [{ name: 'source-review', title: 'Review facts', description: 'Source review', version: '1.2.3', source: exact }] } });
    assert.equal(init?.method, 'POST');
    mutations.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
    return Response.json({ success: true, data: { draft: {}, changed: true } });
  };
  const { PackageCompositionSection } = await import('../app/components/plugins/PackageCompositionSection');
  const { authClient } = await import('../app/lib/auth-client'), atom = authClient.$store.atoms.session, originalSession = atom.get();
  atom.set({ ...atom.get(), data: actor, error: null, isPending: false, isRefetching: false });
  function App() {
    const [pending, setPending] = useState(false);
    return <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <PackageCompositionSection draftRef="canvas-package-draft:draft" revision={7} workspaceId="workspace" disabled={pending}
        onMutation={async operation => { setPending(true); try { await operation(); } finally { setPending(false); } }} />
    </NextIntlClientProvider>;
  }
  try {
    render(<App />); assert.equal(searchCount, 0, 'A closed disclosure does not search providers.');
    const details = document.querySelector('details')!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    await screen.findByText('Read-only source');
    const openRow = (id: string) => fireEvent.click(screen.getAllByTestId('plugin-extension-row-open').find(row => row.getAttribute('data-extension-id') === id)!);
    openRow(skill.id); await screen.findByText(messages.skills.composition.sourceError);
    fireEvent.click(screen.getByRole('button', { name: messages.skills.workspace.catalog.retry }));
    const checkbox = await screen.findByLabelText(/Review facts/u); assert.equal(sourceReads, 2, 'Retry rechecks the same selected source without clearing or changing the catalog query.');
    assert.equal(mutations.length, 0, 'Selecting a readable source is not copying or execution.');
    fireEvent.click(checkbox); fireEvent.change(screen.getByLabelText('Name for Review facts'), { target: { value: 'review-facts' } });
    fireEvent.click(screen.getByRole('button', { name: /Copy skills/u }));
    await waitFor(() => assert.equal(mutations.length, 1));
    assert.deepEqual(mutations[0].body, { expectedDraftRevision: 7, skills: [{ source: exact, targetName: 'review-facts' }] });
    assert.match(mutations[0].path, /compose-skills$/u);
    openRow(integration.id); fireEvent.click(screen.getByRole('button', { name: 'Add requirement' }));
    await waitFor(() => assert.equal(mutations.length, 2));
    assert.deepEqual(mutations[1].body, { expectedDraftRevision: 7, catalogId: 'composio:hubspot', required: true });
    openRow(mcp.id); assert.equal(screen.getByRole('button', { name: 'Add requirement' }).hasAttribute('disabled'), true);
    fireEvent.change(screen.getByLabelText('Connection name within this plugin'), { target: { value: 'company-research' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add requirement' })); await waitFor(() => assert.equal(mutations.length, 3));
    assert.deepEqual(mutations[2].body, { expectedDraftRevision: 7, catalogId: mcp.id, required: true, connectorName: 'company-research' });
    assert(!JSON.stringify(mutations.map(mutation => mutation.body)).includes('PRIVATE_BACKEND'));
    assert(mutations.every(mutation => !/publish|activation|account|agent|session/u.test(mutation.path)), 'Authoring never publishes, grants, connects accounts or executes tools.');
    console.log('PASS mounted authoring selection: genuine shared search/rows, closed disclosure, readable source without Use, explicit exact-copy selection, portable Composio requirement and explicit MCP connector with CAS and no account binding.');
  } finally { cleanup(); atom.set(originalSession); loader._load = original; globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
