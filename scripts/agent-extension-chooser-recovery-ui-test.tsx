import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import { AgentExtensionConnectionChooser, type AgentExtensionChosenConnection } from '../app/components/agents/AgentExtensionConnectionChooser';
import { agentExtensionOptionsRequestSchema, type AgentExtensionOptionsRequest, type AgentExtensionOptionsResponse } from '../app/lib/agents/extension-options-contracts';
import { EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';

// Actual React chooser/request codec. HTTP metadata alone is controlled; this
// proves recovery and selection fencing, never server or provider authority.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://chooser.fixture.invalid', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Node', 'MutationObserver', 'Event', 'getComputedStyle'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const target = { kind: 'prospective' as const, scopeType: 'user' as const };
const context = { workspaceId: 'recovery-workspace', actorId: 'recovery-user' };
type ChoicePage = Extract<AgentExtensionOptionsResponse, { operation: 'connection_choices' }>;

async function main() {
  const { render, screen, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  const originalFetch = globalThis.fetch;
  let cases = 0;
  try {
    for (const view of ['mcp', 'profiles', 'accounts', 'no_auth'] as const) for (const failure of [403, 409, 503, 'context_changed'] as const) {
      let failed = false, reloaded = false, accountReads = 0;
      const chosen: AgentExtensionChosenConnection[] = [];
      const toolkit = view === 'no_auth' ? 'duckduckgo' : 'canva';
      const selector = view === 'mcp' ? { kind: 'standalone' as const, source: 'mcp' as const }
        : { kind: 'standalone' as const, source: 'composio' as const, toolkit };
      const payload = (request: Extract<AgentExtensionOptionsRequest, { operation: 'connection_choices' }>): ChoicePage => {
        const fresh = reloaded;
        const data: ChoicePage = { schemaVersion: 1, operation: 'connection_choices', target, selector,
          contextKey: failure === 'context_changed' && request.cursor ? 'different-current-context' : fresh ? 'reloaded-context' : 'initial-context',
          limits: EXTENSION_SELECTION_LIMITS, coverage: [], connections: [], accounts: [], profiles: [],
          pagination: { nextCursor: fresh ? null : 'next-page', hasNextPage: !fresh, loadedItems: 1 } };
        if (view === 'mcp') {
          data.connections = [{ id: fresh ? 'mcp-fresh' : 'mcp-old', label: fresh ? 'Fresh MCP' : 'Old MCP', scopeLabel: 'personal',
            selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal',
              connectionRef: `mcp-personal:10000000-0000-4000-8000-00000000000${fresh ? '2' : '1'}` } },
            allowedToolNames: null, eligibility: { action: 'select' }, authorization: 'unknown', health: 'unknown', mappingRequired: false }];
        } else if (!request.profileId) data.profiles = [{ profileId: 'own-profile', label: 'My exact profile', status: 'unverified' }];
        else if (view === 'accounts' || view === 'profiles') data.accounts = [{ label: fresh ? 'Fresh account' : 'Old account', status: 'ACTIVE', selectable: true,
          accountSelectionRef: `cmp_personal_account_${(fresh ? 'c' : 'b').repeat(43)}`,
          selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal', profileId: 'own-profile',
            accountBinding: 'account', accountId: fresh ? 'fresh-account' : 'old-account', connectionRef: fresh ? 'composio-personal:own-profile:fresh-account' : 'composio-personal:own-profile:old-account' } } }];
        else {
          data.noAuthSelection = { kind: 'composio', source: 'composio', toolkit: 'duckduckgo', target: { kind: 'personal', profileId: 'own-profile', accountBinding: 'no_auth' } };
          // Profiles are independently paginated metadata; the explicit no-auth
          // selection remains in every page of the exact selected-profile view.
          data.profiles = [{ profileId: 'own-profile', label: 'My exact profile', status: 'unverified' }];
        }
        return data;
      };
      globalThis.fetch = async (input, init) => {
        const address = new URL(String(input), dom.window.location.origin);
        assert.equal(address.pathname, '/api/agents/extension-options'); assert.equal(address.searchParams.get('workspaceId'), context.workspaceId);
        const request = agentExtensionOptionsRequestSchema.parse(JSON.parse(String(init?.body)));
        assert.equal(request.operation, 'connection_choices');
        if (request.operation !== 'connection_choices') throw new Error('Unexpected actual request.');
        if (request.profileId) accountReads++;
        if (request.cursor) {
          failed = true;
          if (failure !== 'context_changed') return Response.json({ success: false, error: `Page failure ${failure}`, code: 'OPTIONS_CHANGED' }, { status: failure });
        } else if (failed) reloaded = true;
        return Response.json({ success: true, data: payload(request) });
      };
      render(<NextIntlClientProvider locale="en" timeZone="UTC"><AgentExtensionConnectionChooser target={target} context={context} selector={selector}
        onSelect={choice => { chosen.push(choice); }} /></NextIntlClientProvider>);
      if (view === 'accounts' || view === 'no_auth') {
        fireEvent.click(await screen.findByRole('button', { name: /My exact profile/u }));
      }
      const choiceName = view === 'mcp' ? 'Choose' : view === 'profiles' ? /My exact profile/u : view === 'accounts' ? 'This account' : 'Use without sign-in';
      const oldButton = await screen.findByRole('button', { name: choiceName });
      await waitFor(() => assert.equal((oldButton as HTMLButtonElement).disabled, false));
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await screen.findByText(failure === 'context_changed' ? 'The context changed. Reload the choices.' : `Page failure ${failure}`);
      const staleButton = screen.getByRole('button', { name: choiceName }) as HTMLButtonElement;
      assert.equal(staleButton.disabled, true); fireEvent.click(staleButton); assert.equal(chosen.length, 0);
      const readsBefore = accountReads;
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      await waitFor(() => assert.equal((screen.getByRole('button', { name: choiceName }) as HTMLButtonElement).disabled, false));
      if (view === 'accounts') { assert(screen.getByText('Fresh account')); assert.equal(accountReads, readsBefore + 1); }
      if (view === 'mcp') { assert(screen.getByText('Fresh MCP')); assert.equal(screen.queryByText('Old MCP'), null); }
      fireEvent.click(screen.getByRole('button', { name: choiceName }));
      if (view === 'profiles') { await screen.findByRole('button', { name: 'This account' }); assert.equal(chosen.length, 0); assert.equal(accountReads, 1); }
      else await waitFor(() => assert.equal(chosen.length, 1));
      if (view === 'accounts') assert.equal(chosen[0].accountSelectionRef, `cmp_personal_account_${'c'.repeat(43)}`);
      cleanup(); cases++;
    }
    console.log(`PASS ${cases} actual chooser recovery cases: loaded connection/profile/account/no-auth pages, 403/409/503/context drift, stale selection blocked and explicit fresh reload.`);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
