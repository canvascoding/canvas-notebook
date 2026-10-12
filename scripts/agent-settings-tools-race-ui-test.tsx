import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { DEFAULT_AGENT_ID } from '../app/lib/channels/constants';
import type { AgentProfileItem } from '../app/components/settings/AgentSelectorCard';
import type { ToolMetadata } from '../app/components/settings/AgentToolsCard';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://agent-settings.fixture.invalid/settings?tab=agent-settings' });
for (const key of ['window', 'self', 'document', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLSelectElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent', 'FocusEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });

/** Actual Panel, Selector, ToolsCard and enabled-tools logic. SafeDTO transport only; no server/ACL/browser acceptance claim. */
async function main(): Promise<void> {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  const searchParams = new URLSearchParams('tab=agent-settings');
  const independentViews = new Set(['MemoryReviewAgentCard', 'AgentRuntimePreferenceCard', 'AgentCatalogModelOverrideEditor',
    'AgentManagedFilesCard', 'AgentSessionsCard', 'AgentDoctorCard']);
  loader._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return { useSearchParams: () => searchParams };
    if (name === 'next/link') return { __esModule: true, default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) { return <a {...props} ref={ref} />; }) };
    if (parent?.filename.endsWith('/AgentSettingsPanel.tsx')) {
      const basename = name.split('/').at(-1)?.replace(/\.tsx$/u, '');
      if (basename && independentViews.has(basename)) return { [basename === 'AgentCatalogModelOverrideEditor' ? 'AgentCatalogModelOverrideCard' : basename]: () => null };
    }
    return originalLoad(name, parent, isMain);
  };
  const { render, screen, within, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
  const { AgentSettingsPanel } = await import('../app/components/settings/AgentSettingsPanel');
  const profile = (agentId: string, name: string, enabledTools: string[]): AgentProfileItem => ({ agentId, name, iconId: 'bot',
    type: agentId === DEFAULT_AGENT_ID ? 'main' : 'special', removable: agentId !== DEFAULT_AGENT_ID,
    defaultProviderInstallationId: null, defaultProvider: null, defaultModel: null, defaultThinking: null,
    enabledTools, relevantSkills: null, relevantConnections: null, scopeType: agentId === DEFAULT_AGENT_ID ? 'system' : 'user',
    organizationId: 'fixture-org', ownerUserId: agentId === DEFAULT_AGENT_ID ? null : 'fixture-user', createdByUserId: 'fixture-user', revision: 1,
    access: { canUse: true, canEdit: true, canManage: true } });
  let alpha = profile(DEFAULT_AGENT_ID, 'Agent Alpha', ['ls']);
  let beta = profile('fixture-beta', 'Agent Beta', ['glob']);
  const tools: ToolMetadata[] = [{ name: 'read', label: 'Read files', description: 'Reads a file.', group: 'Core', planningModeAllowed: true },
    { name: 'ls', label: 'List files', description: 'Lists files.', group: 'Core', planningModeAllowed: true },
    { name: 'glob', label: 'Find file paths', description: 'Finds file paths.', group: 'Core', planningModeAllowed: true }];
  type RequestRecord = { url: URL; method: string; body: Record<string, unknown> | null };
  type HeldResponse = { release(): void };
  const requests: RequestRecord[] = [], writes: Record<string, unknown>[] = [], pending: HeldResponse[] = [];
  let intercept: ((request: RequestRecord, reply: () => Response) => Response | Promise<Response> | undefined) | undefined;
  const response = (data: unknown) => Response.json({ success: true, data });
  const retain = (reply: Response): { promise: Promise<Response>; release(): void } => {
    let resolve!: (value: Response) => void;
    const held = { promise: new Promise<Response>(done => { resolve = done; }), release: () => resolve(reply) };
    pending.push(held); return held;
  };
  const toolPayload = (current: AgentProfileItem) => {
    assert(Array.isArray(current.enabledTools));
    return { tools, config: { agentId: current.agentId, enabledTools: [...current.enabledTools] } };
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.origin), method = init?.method ?? 'GET';
    const request = { url, method, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null };
    requests.push(request); if (method === 'PATCH') { assert(request.body); writes.push(request.body); }
    const reply = (): Response => {
      if (url.pathname === '/api/agents' && method === 'GET') return response({ agents: [alpha, beta] });
      if (['/api/agents', '/api/agents/tools'].includes(url.pathname) && method === 'PATCH') {
        const value = request.body; assert(value);
        const current = value.agentId === alpha.agentId ? alpha : beta;
        assert.equal(value.agentId, current.agentId);
        if (url.pathname === '/api/agents') assert.equal(value.expectedRevision, current.revision);
        const next = { ...current, revision: current.revision + 1 };
        for (const key of ['enabledTools', 'relevantSkills', 'relevantConnections'] as const) {
          if (!(key in value)) continue;
          const names: unknown = value[key]; assert(names === null || Array.isArray(names) && names.every(name => typeof name === 'string'));
          next[key] = names === null ? null : [...names] as string[];
        }
        if (current.agentId === alpha.agentId) alpha = next; else beta = next;
        return url.pathname === '/api/agents' ? response({ agent: next }) : response({ config: toolPayload(next).config });
      }
      if (url.pathname === '/api/agents/tools' && method === 'GET') {
        const agentId = url.searchParams.get('agentId'); assert(agentId === alpha.agentId || agentId === beta.agentId);
        return response(toolPayload(agentId === alpha.agentId ? alpha : beta));
      }
      if (url.pathname === '/api/agents/files' && method === 'GET') return response({ files: Object.fromEntries(['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'].map(name => [name, ''])) });
      if (url.pathname === '/api/sessions' && method === 'GET') return Response.json({ success: true, sessions: [] });
      throw new Error(`Unexpected controlled fixture request: ${method} ${url.pathname}`);
    };
    return intercept?.(request, reply) ?? reply();
  };
  const toolSwitch = (label: string) => {
    const tool = tools.find(entry => entry.label === label); assert(tool);
    const row = screen.getByText(tool.name).closest<HTMLElement>('[data-slot="collapsible"]'); assert(row);
    return within(row).getByRole('switch', { name: label });
  };
  const checked = (name: string) => toolSwitch(name).getAttribute('aria-checked') === 'true';
  const selected = (name: 'Alpha' | 'Beta') => screen.getByRole('button', { name: new RegExp(`Agent ${name}`, 'u') }).getAttribute('aria-pressed') === 'true';
  const choose = (name: 'Alpha' | 'Beta') => fireEvent.click(screen.getByRole('button', { name: new RegExp(`Agent ${name}`, 'u') }));
  const toolGet = (request: RequestRecord, agentId: string) => request.method === 'GET' && request.url.pathname === '/api/agents/tools' && request.url.searchParams.get('agentId') === agentId;
  const toolReads = (agentId: string) => requests.filter(request => toolGet(request, agentId)).length;
  const mount = (handler?: typeof intercept) => {
    cleanup(); for (const held of pending.splice(0)) held.release();
    alpha = profile(DEFAULT_AGENT_ID, 'Agent Alpha', ['ls']); beta = profile('fixture-beta', 'Agent Beta', ['glob']);
    requests.length = 0; writes.length = 0; intercept = handler;
    dom.window.localStorage.setItem('canvas-settings-agent-section-open-state', JSON.stringify({ tools: true }));
    render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><AgentSettingsPanel /></NextIntlClientProvider>);
  };
  const ready = async (name: 'Alpha' | 'Beta') => {
    await waitFor(() => { assert(selected(name)); assert.equal(checked(name === 'Alpha' ? 'List files' : 'Find file paths'), true); });
  };
  const release = (held: HeldResponse) => act(async () => held.release());
  let cases = 0;
  try {
    const heldAlpha: HeldResponse[] = [];
    mount((request, reply) => {
      if (!toolGet(request, alpha.agentId)) return;
      const held = retain(reply()); heldAlpha.push(held); return held.promise;
    });
    await screen.findByRole('button', { name: /Agent Beta/u });
    await waitFor(() => assert(heldAlpha.length >= 1));
    choose('Beta'); await ready('Beta'); intercept = undefined;
    await act(async () => { for (const held of heldAlpha) held.release(); });
    const visible = { selectedBeta: selected('Beta'),
      betaGlobEnabled: checked('Find file paths'), alphaLsEnabled: checked('List files') };
    fireEvent.click(toolSwitch('Read files'));
    await waitFor(() => assert.equal(writes.length, 1));
    console.log(`actual AgentSettingsPanel deferred A→B observation: ${JSON.stringify({ visible, capturedBetaWrite: writes[0] })}`);
    assert.deepEqual(visible, { selectedBeta: true, betaGlobEnabled: true, alphaLsEnabled: false }, 'Late A tool/config responses must not replace visible B selections.');
    assert(Array.isArray(writes[0].enabledTools));
    assert.deepEqual([...writes[0].enabledTools].sort(), ['glob', 'read'], 'The actual B PATCH must retain B configuration and contain no stale A selection.');
    await waitFor(() => assert.equal(checked('Read files'), true)); cases += 1;

    const epochAlpha: HeldResponse[] = [];
    mount((request, reply) => {
      if (!toolGet(request, alpha.agentId)) return;
      const held = retain(reply()); epochAlpha.push(held); return held.promise;
    });
    await screen.findByRole('button', { name: /Agent Beta/u }); await waitFor(() => assert(epochAlpha.length >= 1));
    choose('Beta'); await ready('Beta'); intercept = undefined;
    alpha = { ...alpha, enabledTools: ['read'] }; choose('Alpha');
    await waitFor(() => { assert(selected('Alpha')); assert(checked('Read files')); assert(!checked('List files')); });
    await act(async () => { for (const held of epochAlpha) held.release(); });
    assert(checked('Read files')); assert(!checked('List files')); assert.equal(writes.length, 0); cases += 1;

    mount(); await ready('Alpha'); choose('Beta'); await ready('Beta');
    const pendingRead: HeldResponse[] = [];
    intercept = (request, reply) => {
      if (!toolGet(request, beta.agentId)) return;
      const held = retain(reply()); pendingRead.push(held); return held.promise;
    };
    fireEvent.click(screen.getByRole('switch', { name: messages.settings.agentPanel.capabilities.skillsToggle }));
    await waitFor(() => assert(pendingRead.length >= 1));
    assert(screen.getAllByText(messages.settings.agentPanel.tools.loading).length >= 1);
    assert.equal(screen.queryByRole('switch', { name: 'Read files' }), null);
    fireEvent.click(screen.getByRole('switch', { name: messages.settings.agentPanel.inheritance.toolsOverride }));
    assert.equal(writes.filter(value => 'enabledTools' in value).length, 0, 'A held same-agent preSave GET fences actual tools override mutation too.');
    intercept = undefined; await act(async () => { for (const held of pendingRead) held.release(); }); await ready('Beta');
    fireEvent.click(toolSwitch('Read files'));
    await waitFor(() => assert(checked('Read files')));
    const freshWrite = writes.find(value => 'enabledTools' in value); assert(freshWrite && Array.isArray(freshWrite.enabledTools));
    assert.deepEqual([...freshWrite.enabledTools].sort(), ['glob', 'read']); cases += 1;

    for (const outcome of ['ack', 'error'] as const) {
      mount(); await ready('Alpha'); choose('Beta'); await ready('Beta');
      let oldSave: HeldResponse | undefined;
      const currentReads: HeldResponse[] = [];
      intercept = (request, reply) => {
        if (request.method === 'PATCH' && request.body?.agentId === beta.agentId) {
          const held = retain(outcome === 'ack' ? reply() : Response.json({ success: false, error: 'Departed agent save failed.' }, { status: 503 }));
          oldSave = held; return held.promise;
        }
        if (toolGet(request, alpha.agentId)) { const held = retain(reply()); currentReads.push(held); return held.promise; }
      };
      fireEvent.click(toolSwitch('Read files')); await waitFor(() => assert(oldSave));
      const oldReadCount = toolReads(beta.agentId);
      choose('Alpha'); await waitFor(() => assert(currentReads.length >= 1));
      assert(screen.getAllByText(messages.settings.agentPanel.tools.loading).length >= 1); assert(oldSave); await release(oldSave);
      assert(selected('Alpha')); assert(screen.getAllByText(messages.settings.agentPanel.tools.loading).length >= 1);
      assert.equal(screen.queryByText('Departed agent save failed.'), null);
      assert.equal(toolReads(beta.agentId), oldReadCount, 'A departed managed-agent save must not start an old-agent postSave reload.');
      intercept = undefined; await act(async () => { for (const held of currentReads) held.release(); }); await ready('Alpha');
      assert(!checked('Read files')); assert.equal(writes.length, 1); cases += 1;
    }

    mount(); await ready('Alpha');
    intercept = request => toolGet(request, beta.agentId) ? response({ tools, config: { agentId: alpha.agentId, enabledTools: ['ls'] } }) : undefined;
    choose('Beta'); await screen.findByText(messages.settings.agentPanel.tools.saveError);
    assert(selected('Beta')); assert.equal(screen.queryByRole('switch', { name: 'Read files' }), null);
    const enableAll = screen.getByRole('button', { name: messages.settings.agentPanel.tools.enableAll }) as HTMLButtonElement;
    assert(enableAll.disabled); fireEvent.click(enableAll); assert.equal(writes.length, 0);
    assert.equal(screen.queryByText(messages.settings.agentPanel.tools.loading), null); cases += 1;

    mount(); await ready('Alpha');
    let pendingAlphaWrite: HeldResponse | undefined;
    intercept = (request, reply) => {
      if (request.method !== 'PATCH' || request.body?.agentId !== alpha.agentId) return;
      const held = retain(reply()); pendingAlphaWrite = held; return held.promise;
    };
    fireEvent.click(toolSwitch('Read files')); await waitFor(() => assert(pendingAlphaWrite));
    choose('Beta'); await ready('Beta'); assert(!checked('Read files'));
    const alphaReadCount = toolReads(alpha.agentId); choose('Alpha');
    await waitFor(() => { assert(selected('Alpha')); assert(screen.getAllByText(messages.settings.agentPanel.tools.loading).length >= 1); });
    assert.equal(toolReads(alpha.agentId), alphaReadCount, 'Returning to the writing agent waits for its exact outstanding write acknowledgement before GET.');
    assert(pendingAlphaWrite); await release(pendingAlphaWrite);
    await waitFor(() => { assert(checked('Read files')); assert(checked('List files')); });
    assert.equal(toolReads(alpha.agentId), alphaReadCount + 1);
    assert.equal((toolSwitch('Read files') as HTMLButtonElement).disabled, false);
    assert.equal(writes.length, 1); assert.equal(writes[0].agentId, alpha.agentId); cases += 1;
    console.log(`agent-settings-tools-race-ui-test: PASS ${cases} actual Panel/Selector/ToolsCard cases: A→B and A→B→A epochs, held same-agent read fence/fresh save, departed save ack/error, mismatched config and pending-write return/fresh read; controlled SafeDTO UI transport only, no server/ACL/native-browser claim.`);
  } finally {
    cleanup(); for (const held of pending) held.release(); loader._load = originalLoad; globalThis.fetch = originalFetch; dom.window.localStorage.clear(); dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
