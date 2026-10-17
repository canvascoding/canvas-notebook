import assert from 'node:assert/strict';
import Module from 'node:module';
import React from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { AgentWorkflowManagementDialogProps } from '../app/components/agents/AgentWorkflowManagementDialog';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://setup.fixture.invalid/plugins', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: Reflect.get(dom.window, key), configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const session = { user: { id: 'actor' }, session: { id: 'session' } };
let currentSession: typeof session | null = session;
let managementProps: AgentWorkflowManagementDialogProps | null = null;
const loader = Module as unknown as { _load(name: string, parent?: unknown, isMain?: boolean): unknown; _resolveFilename(name: string, parent?: unknown): string };
const originalLoad = loader._load, originalFetch = globalThis.fetch;
loader._load = (name, parent, isMain) => {
  let resolved = name; try { resolved = loader._resolveFilename(name, parent); } catch { /* Alias matches below. */ }
  if (name === '@/app/lib/auth-client' || resolved.endsWith('/app/lib/auth-client.ts')) return { authClient: { useSession: () => ({ data: session, isPending: false, error: null }), getSession: async () => ({ data: currentSession }) } };
  if (name === '@/app/components/agents/AgentWorkflowManagementDialog' || resolved.endsWith('/app/components/agents/AgentWorkflowManagementDialog.tsx')) return {
    AgentWorkflowManagementDialog: (props: AgentWorkflowManagementDialogProps) => { if (props.open) managementProps = props; return null; },
  };
  return originalLoad(name, parent, isMain);
};
async function main() {
  const { render, screen, fireEvent, act, waitFor, cleanup } = await import('@testing-library/react');
  const { PackageAgentSetup } = await import('../app/components/plugins/PackageAgentSetup');
  const { confirmPluginNavigation } = await import('../app/components/plugins/plugin-navigation-guard');
  const reads: string[] = [], writes: { url: URL; body: Record<string, unknown> }[] = [];
  let release: (() => void) | null = null, held: Promise<void> | null = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.origin);
    assert.equal(init?.credentials, (init?.method ?? 'GET') === 'GET' ? 'same-origin' : 'include'); assert.equal(init?.cache, 'no-store');
    if ((init?.method ?? 'GET') === 'GET') {
      assert.equal(url.pathname, '/api/agents'); assert.equal(url.searchParams.get('purpose'), 'configure');
      assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), url.searchParams.get('workspaceId'));
      reads.push(url.searchParams.get('workspaceId')!);
      return Response.json({ success: true, data: { agents: [
        { agentId: 'main', name: 'Main', type: 'main', access: { canEdit: true } },
        { agentId: 'use-only', name: 'Use only', type: 'special', access: { canEdit: false } },
        { agentId: 'alpha', name: 'Alpha', type: 'special', access: { canEdit: true } },
        { agentId: 'beta', name: 'Beta', type: 'special', access: { canEdit: true } },
      ] } });
    }
    assert.equal(init?.method, 'PATCH'); assert.equal(url.pathname, '/api/agents');
    const body = JSON.parse(String(init?.body)); writes.push({ url, body }); await held;
    return Response.json({ success: true, data: { agent: { agentId: body.agentId, revision: body.expectedRevision + 1,
      workflowRevision: body.expectedWorkflowRevision }, workflow: { agentId: body.agentId, revision: body.expectedRevision + 1, workflowRevision: body.expectedWorkflowRevision } } });
  };
  const view = (workspaceId: string) => <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    <PackageAgentSetup workspaceId={workspaceId} resourceRef="canvas-resource:11111111-1111-4111-8111-111111111111" packageName="Design workflow" />
  </NextIntlClientProvider>;
  const rendered = render(view('workspace-alpha'));
  assert.equal(reads.length, 0, 'Agent inventory is loaded only when the optional step is opened');
  fireEvent.click(screen.getByTestId('package-agent-setup-expand'));
  await screen.findByTestId('package-agent-setup-select');
  assert.equal((screen.getByTestId('package-agent-setup-open') as HTMLButtonElement).disabled, true, 'Multiple actual agents require explicit choice');
  assert.equal(screen.queryByText('Use only'), null);
  fireEvent.change(screen.getByTestId('package-agent-setup-select'), { target: { value: 'beta' } });
  fireEvent.click(screen.getByTestId('package-agent-setup-open'));
  await waitFor(() => assert(managementProps));
  const captured = managementProps!;
  assert.equal(captured.agentId, 'beta'); assert.equal(captured.context.workspaceId, 'workspace-alpha'); assert.equal(captured.context.actorId, 'actor');
  window.confirm = () => false;
  await act(async () => captured.onDraftStateChange?.({ dirty: true, pending: false }));
  assert.equal(confirmPluginNavigation(), false, 'Unsaved workflow edits protect Plugin navigation');
  window.confirm = () => true;
  held = new Promise<void>(resolve => { release = resolve; });
  const input = { agentId: 'beta', expectedRevision: 2, expectedWorkflowRevision: 1, enabledTools: ['read'] };
  const mutation = captured.commit(input, { context: captured.context, selectionEpoch: captured.selectionEpoch });
  void mutation.catch(() => {});
  await waitFor(() => assert.equal(writes.length, 1));
  assert.equal(confirmPluginNavigation(), false, 'Pending actual workflow write cannot be discarded by navigation');
  assert.equal(writes[0].url.searchParams.get('workspaceId'), 'workspace-alpha');
  assert.deepEqual(writes[0].body, input, 'The existing manager receives exact actual-agent revisions and input');
  release!(); await mutation;
  await act(async () => captured.onDraftStateChange?.({ dirty: false, pending: false }));
  assert.equal(confirmPluginNavigation(), true);
  currentSession = { user: { id: 'different-actor' }, session: { id: 'session' } };
  await assert.rejects(captured.commit(input, { context: captured.context, selectionEpoch: captured.selectionEpoch }), (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'status') === 403));
  assert.equal(writes.length, 1, 'A session change stops writes before sending');
  currentSession = session;
  rendered.rerender(view('workspace-beta'));
  await assert.rejects(captured.commit(input, { context: captured.context, selectionEpoch: captured.selectionEpoch }));
  assert.equal(writes.length, 1, 'A detached workspace cannot deliver a stale workflow mutation');
  cleanup();
  console.log('PASS optional package-agent setup: lazy real-agent discovery, explicit choices, existing workflow CAS client, session/workspace fences and pending/dirty navigation.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { loader._load = originalLoad; globalThis.fetch = originalFetch; dom.window.close(); });
