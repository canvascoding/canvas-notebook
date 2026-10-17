import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { agentExtensionOptionsRequestSchema, type AgentExtensionPackageVersion } from '../app/lib/agents/extension-options-contracts';
import { EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';
import type { FixedAgentExtensionConfiguration } from '../app/components/agents/agent-extension-editor-draft';

// Actual package editor, request parser and avatar. Only metadata HTTP responses
// are controlled; this test makes no SQL, authorization or browser claim.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://package-summary.fixture.invalid/settings', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement',
  'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const pin = { resourceRef: 'canvas-resource:10000000-0000-4000-8000-000000000001',
  publishedRevisionRef: 'canvas-package-revision:10000000-0000-4000-8000-000000000002', checksum: 'a'.repeat(64) };
const pkg = { ...pin, skillSelection: { kind: 'plugin' as const }, declarations: [] };
const configuration: FixedAgentExtensionConfiguration = { version: 1, origin: 'agent_configuration', mode: 'fixed',
  selections: [{ selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'required', toolCap: null }],
  workflow: { version: 1, packages: [pkg] }, standalone: [] };
const metadata: AgentExtensionPackageVersion = { pin, kind: 'plugin', name: 'exact-published-plugin', displayName: 'Design Library',
  description: 'The exact held package', version: '1.0.0', icon: { url: 'https://logos.fixture.invalid/design.svg', sourceKey: 'published-design-icon' },
  children: [{ name: 'design-context', title: 'Design context', description: 'A published child', relativeRoot: 'skills/design', origin: 'plugin_child', required: false }],
  declarations: [] };
const context = { actorId: 'summary-user', workspaceId: 'workspace-a', organizationId: 'organization-a' };
const target = { kind: 'existing' as const, agentId: 'existing-summary-agent', expectedRevision: 3, expectedWorkflowRevision: 2 };
type PackageRequest = Extract<ReturnType<typeof agentExtensionOptionsRequestSchema.parse>, { operation: 'package_version' }>;
type Pending = { request: PackageRequest; url: URL; signal?: AbortSignal | null; resolve: (response: Response) => void };

async function main() {
  const { render, screen, within, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
  const { AgentExtensionPackageEditor } = await import('../app/components/agents/AgentExtensionPackageEditor');
  const savedFetch = globalThis.fetch, before = structuredClone(configuration), requests: Pending[] = [];
  let changes = 0, cases = 0;
  globalThis.fetch = async (input, init) => {
    const request = agentExtensionOptionsRequestSchema.parse(JSON.parse(String(init?.body)));
    assert.equal(request.operation, 'package_version', 'Opening a saved package only reads its exact version.');
    if (request.operation !== 'package_version') throw new Error('Only package metadata is permitted.');
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, dom.window.location.origin);
    return new Promise<Response>(resolve => requests.push({ request, url, signal: init?.signal, resolve }));
  };
  const wrap = (node: React.ReactNode, locale = 'en') => <NextIntlClientProvider locale={locale} timeZone="UTC" messages={{}}>{node}</NextIntlClientProvider>;
  const component = (scope = context, initialMetadata?: AgentExtensionPackageVersion) => <AgentExtensionPackageEditor
    configuration={configuration} pkg={pkg} target={target} context={scope} initialMetadata={initialMetadata} onChange={() => { changes++; }} />;
  const reply = (pending: Pending, value = metadata) => Response.json({ success: true, data: { schemaVersion: 1, operation: 'package_version',
    target: pending.request.target, contextKey: `actual-request:${pending.url.searchParams.get('workspaceId')}`, coverage: [{ source: 'packages', status: 'complete' }],
    limits: EXTENSION_SELECTION_LIMITS, package: value } });
  const summary = () => screen.getByTestId('agent-extension-package-summary');
  const closed = () => assert.equal(screen.getByTestId<HTMLDetailsElement>('agent-extension-package').open, false);
  const noInventedIdentity = () => {
    assert.equal(within(summary()).queryByTestId('plugin-extension-avatar'), null);
    assert.equal(within(summary()).queryByTestId('plugin-extension-avatar-initials'), null);
    assert(!summary().textContent?.includes('Published package'));
  };
  try {
    render(wrap(component()));
    await waitFor(() => assert.equal(requests.length, 1)); closed(); noInventedIdentity();
    assert.equal(within(summary()).getByRole('status').textContent, 'Checking the package version…');
    assert(within(summary()).getByTestId('agent-extension-package-metadata-placeholder'));
    assert.deepEqual(requests[0].request, { operation: 'package_version', target, ...pin });
    assert.equal(requests[0].url.pathname, '/api/agents/extension-options');
    assert.equal(requests[0].url.searchParams.get('workspaceId'), context.workspaceId);
    assert.equal(requests[0].url.searchParams.get('organizationId'), context.organizationId);
    assert.equal(requests[0].url.searchParams.has('actorId'), false); cases++;

    await act(async () => requests[0].resolve(Response.json({ success: false, code: 'PACKAGE_SNAPSHOT_UNAVAILABLE', error: 'The exact source is temporarily unavailable.' }, { status: 503 })));
    await waitFor(() => assert(within(summary()).getByRole('alert').textContent?.includes('could not be loaded')));
    closed(); noInventedIdentity(); assert.equal(within(summary()).queryByRole('status'), null); cases++;

    fireEvent.click(summary());
    assert.equal(screen.getByTestId<HTMLDetailsElement>('agent-extension-package').open, true);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => assert.equal(requests.length, 2));
    fireEvent.click(summary()); closed(); noInventedIdentity();
    assert.equal(within(summary()).getByRole('status').textContent, 'Checking the package version…');
    assert.deepEqual(requests[1].request, requests[0].request);
    await act(async () => requests[1].resolve(reply(requests[1])));
    await waitFor(() => assert(summary().textContent?.includes(metadata.displayName)));
    closed(); assert.equal(within(summary()).queryByRole('status'), null); assert.equal(within(summary()).queryByRole('alert'), null);
    const avatar = within(summary()).getByTestId('plugin-extension-avatar');
    assert.equal(avatar.dataset.sourceKey, metadata.icon!.sourceKey);
    assert.equal(within(avatar).getByTestId('plugin-extension-avatar-image').getAttribute('src'), metadata.icon!.url);
    assert.equal(within(summary()).queryByTestId('agent-extension-package-metadata-placeholder'), null); cases++;
    fireEvent.error(within(avatar).getByTestId('plugin-extension-avatar-image'));
    assert.equal(within(avatar).getByTestId('plugin-extension-avatar-initials').textContent, 'DL'); cases++;

    cleanup(); const reads = requests.length;
    render(wrap(component(context, { ...metadata, icon: undefined, displayName: 'Wissen' }), 'de'));
    assert(summary().textContent?.includes('Wissen'));
    assert.equal(within(summary()).getByTestId('plugin-extension-avatar-initials').textContent, 'WI');
    await act(async () => {}); assert.equal(requests.length, reads, 'Actual supplied exact metadata is reused.'); cases++;

    cleanup(); const view = render(wrap(component(), 'de'));
    await waitFor(() => assert.equal(requests.length, reads + 1));
    assert.equal(within(summary()).getByRole('status').textContent, 'Paketstand wird geprüft …');
    const oldRead = requests.at(-1)!;
    view.rerender(wrap(component({ ...context, workspaceId: 'workspace-b' }), 'de'));
    await waitFor(() => assert.equal(requests.length, reads + 2)); assert.equal(oldRead.signal?.aborted, true);
    await act(async () => oldRead.resolve(reply(oldRead)));
    closed(); noInventedIdentity(); assert(!summary().textContent?.includes(metadata.displayName));
    const currentRead = requests.at(-1)!;
    assert.equal(currentRead.url.searchParams.get('workspaceId'), 'workspace-b');
    await act(async () => currentRead.resolve(Response.json({ success: false, code: 'AGENT_ACCESS_DENIED', error: 'Source access denied.' }, { status: 403 })));
    await waitFor(() => assert(within(summary()).getByRole('alert').textContent?.includes('konnten nicht geladen werden')));
    closed(); noInventedIdentity(); cases++;

    assert.equal(changes, 0, 'Loading, failure, retry and icon fallback never mutate the Agent selection.');
    assert.deepEqual(configuration, before);
    console.log(`PASS ${cases} actual package-summary React cases: closed loading/error states, no invented initials, exact-pin retry, real display name/icon and initials, DE/EN and late-scope isolation; controlled metadata HTTP, no authorization or browser claim.`);
  } finally {
    cleanup(); globalThis.fetch = savedFetch;
    for (const pending of requests) pending.resolve(Response.json({ success: false }, { status: 503 }));
    dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
