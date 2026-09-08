import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import { DIRECT_MCP_OAUTH_FAILURE_CODES } from '../app/lib/mcp/server/oauth-diagnostic-codes';

// Component regression only: no browser, server, or live credentials required.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://notebook.example.test/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const { render, cleanup, fireEvent } = await import('@testing-library/react');
  const { McpServerSettingsPanel } = await import('../app/components/settings/McpServerSettingsPanel');
  const originalFetch = globalThis.fetch;
  try {
    for (const [locale, messages] of [['en', en], ['de', de]] as const) {
      const labels = messages.settings.mcpServer;
      for (const policy of ['active', 'restricted', 'disabled', 'missing'] as const) {
        globalThis.fetch = async (input) => {
          const pathname = String(input);
          let data: unknown;
          if (pathname.endsWith('/connections')) {
            data = { connections: [{ connectionId: 'test-connection', clientName: 'ChatGPT',
              scopes: ['knowledge:read', 'knowledge:write'],
              effectiveScopes: policy === 'active' ? ['knowledge:read', 'knowledge:write'] : [],
              resourcePolicyStatus: policy === 'restricted' ? 'active' : policy,
              connectedAt: null, updatedAt: null, allowedWorkspaceCount: 0,
            }] };
          } else if (pathname.endsWith('/workspaces')) {
            data = { workspaces: [] };
          } else if (pathname.endsWith('/requests')) {
            data = { retentionHours: 24, entries: DIRECT_MCP_OAUTH_FAILURE_CODES.map((code) => ({
              requestId: code, httpMethod: 'POST', phase: 'oauth.token', code,
              outcome: 'rejected', statusCode: 400, durationMs: 2,
              clientName: 'ChatGPT', createdAt: '2026-09-08T12:00:00Z',
            })) };
          } else if (pathname === '/api/integrations/mcp-server') {
            data = { desiredEnabled: true, runtimeEnabled: true, endpoint: 'https://notebook.example.test/mcp',
              capabilities: [{ id: 'edit_knowledge_source', enabled: true, available: true, scopes: ['knowledge:write'] }],
            };
          } else throw new Error(`Unexpected request: ${pathname}`);
          return Response.json({ success: true, data });
        };
        const screen = render(<NextIntlClientProvider locale={locale} timeZone="Europe/Berlin" messages={messages}>
          <McpServerSettingsPanel isAdmin />
        </NextIntlClientProvider>);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
        assert.ok(screen.getByText('ChatGPT'));
        assert.ok(screen.getByText(labels.connections.approvedPermissions));
        assert.ok(screen.getByText(labels.connections.tokenNotVerified));
        assert.ok(screen.getByText(labels.connections.workspaceAccess.noneSelected));
        assert.equal(Boolean(screen.queryByText(labels.connections.permissionsComplete)), policy === 'active');
        assert.equal(Boolean(screen.queryByText(labels.connections.permissionsMissing.title)), policy === 'restricted');
        assert.equal(Boolean(screen.queryByText(labels.connections.resourceUnavailable)), policy === 'disabled' || policy === 'missing');
        const history = document.querySelector('#mcp-server-request-history-title')!.closest('details')!;
        await act(async () => { fireEvent.click(history.querySelector('button')!); });
        for (const code of DIRECT_MCP_OAUTH_FAILURE_CODES) {
          assert.ok(screen.getByText(labels.requestHistory.reasons[code]));
        }
        cleanup();
      }
    }
    console.log('mcp-server-settings-ui-test: ok (en/de, consent vs policy, workspace warning, rejection reasons)');
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
