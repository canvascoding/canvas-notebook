import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import { getSecretCategories } from '../app/lib/secrets/env-registry';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://notebook.example.test/settings', pretendToBeVisual: true });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'getComputedStyle'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
const internals = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = internals._load;
let query = new URLSearchParams();
const noopComponent = () => null;
let fixtureMcpHelpers: Record<string, unknown>;
internals._load = function (name, ...args) {
  if (name === 'next/navigation') return { useSearchParams: () => query };
  if (name === 'next/dynamic') return { __esModule: true, default: () => noopComponent };
  if (name.endsWith('/HintProvider')) return { useHintContext: () => ({ activeTabOverride: null }) };
  if (name.endsWith('/McpServerDialog')) {
    fixtureMcpHelpers ??= originalLoad.call(this, name, ...args) as Record<string, unknown>;
    return { ...fixtureMcpHelpers, McpServerDialog: (props: { open: boolean; draft: Record<string, unknown>; onDraftChange: (draft: Record<string, unknown>) => void; onSave: () => void }) => props.open ? <div>
      <button onClick={() => props.onDraftChange({ ...props.draft, name: 'fixture', mode: 'stdio', command: 'node', env: [{ id: 'fixture-key', key: 'TOKEN', value: 'mcp-fixture-new', storeInEnv: true, envKey: 'MCP_FIXTURE_TOKEN' }] })}>Fill fixture MCP</button>
      <button onClick={props.onSave}>Save fixture MCP</button>
    </div> : null };
  }
  if (name.endsWith('/UnifiedSecretsEditor')) return { UnifiedSecretsEditor: (props: { language: string; isAdmin: boolean }) => <div data-testid="unified-secrets" data-language={props.language} data-admin={String(props.isAdmin)} /> };
  if (name.startsWith('@/app/components/') && !name.endsWith('/SettingsAccordionCard') && !name.endsWith('/SettingsNavigation') && !name.endsWith('/McpConnectionHealthStatus')) return new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : noopComponent });
  return originalLoad.call(this, name, ...args);
};

async function main() {
  const oldFetch = globalThis.fetch;
  const { render, cleanup, fireEvent } = await import('@testing-library/react');
  const { IntegrationsSettingsClient, SearchIntegrationCard, EmailAccountsCard, patchSettingsIntegrationEnv } = await import('../app/components/settings/IntegrationsSettingsClient');
  type Patch = { key: string; value: string | null };
  const writes: Array<{ scope: string; secretScope: string; patches: Patch[] }> = [];
  const values = new Map<string, string>([['BRAVE_API_KEY', 'fixture-old'], ['OLLAMA_API_KEY', 'keep-ollama'], ['OTHER_KEY', 'keep-other'], ['CANVAS_PROFILE_AGENTS__OPENAI_API_KEY', 'keep-profile'], ['GOOGLE_OAUTH_CLIENT_ID', 'google-old'], ['GOOGLE_OAUTH_CLIENT_SECRET', 'google-secret-old']]);
  let configRaw = '{"mcpServers":{}}';
  let events = 0;
  const onUpdate = (event: Event) => { assert.equal((event as CustomEvent).detail.secretScope, 'user'); events++; };
  window.addEventListener('canvas_secrets_updated', onUpdate);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('/api/integrations/env')) {
      if (init?.method && init.method !== 'GET') {
        assert.equal(init.method, 'PATCH'); assert.equal(init.credentials, 'include');
        const body = JSON.parse(String(init.body));
        assert.equal(body.scope, 'integrations'); assert.equal(body.secretScope, 'user'); assert.equal('entries' in body, false); assert.equal('rawContent' in body, false);
        writes.push(body);
        for (const patch of body.patches) {
          if (patch.value === null) values.delete(patch.key);
          else values.set(patch.key, patch.value);
        }
      }
      return Response.json({ success: true, data: { entries: [...values].map(([key, value]) => ({ key, value, encrypted: false })) } });
    }
    if (url === '/api/integrations/search/status') return Response.json({ success: true, data: { provider: 'brave', mode: 'local', configured: true, localConfigured: true } });
    if (url.startsWith('/api/email/accounts')) return Response.json({ success: true, data: { mode: 'local', accounts: [] } });
    if (url === '/api/user-preferences') return Response.json({ success: true, data: {} });
    if (url === '/api/email/oauth/status') return Response.json({ success: true, data: { mode: 'local', providers: { google: { configured: true } } } });
    if (url === '/api/email/oauth/google/start') return Response.json({ success: false, error: 'Fixture stops before external OAuth navigation.' }, { status: 400 });
    if (url === '/api/integrations/mcp-config') { if (init?.method === 'PUT') configRaw = JSON.parse(String(init.body)).rawContent; return Response.json({ success: true, data: { path: 'fixture-config', exists: true, rawContent: configRaw } }); }
    if (url === '/api/integrations/mcp-status') return Response.json({ success: true, data: { servers: [], directTools: [], warnings: [], oauth: [], canManageDefinitions: true } });
    throw new Error(`Unexpected fixture request ${url}`);
  };
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); }); };
  const wrap = (child: React.ReactNode, locale: 'en' | 'de' = 'en') => <NextIntlClientProvider locale={locale} timeZone="Europe/Berlin" messages={locale === 'de' ? de : en}>{child}</NextIntlClientProvider>;
  try {
    for (const locale of ['en', 'de'] as const) {
      const screen = render(wrap(<SearchIntegrationCard isOpen onOpenChange={() => undefined} onEnvSaved={async () => undefined} />, locale)); await settle();
      fireEvent.change(document.querySelector('#search-brave-api-key')!, { target: { value: ` search-${locale} ` } });
      fireEvent.click(screen.getByRole('button', { name: (locale === 'en' ? en : de).settings.searchIntegration.save })); await settle();
      assert.deepEqual(writes.at(-1)?.patches, [{ key: 'BRAVE_API_KEY', value: `search-${locale}` }, { key: 'WEB_SEARCH_PROVIDER', value: 'brave' }]);
      fireEvent.click(screen.getByRole('button', { name: (locale === 'en' ? en : de).settings.searchIntegration.remove })); await settle();
      assert.deepEqual(writes.at(-1)?.patches, [{ key: 'BRAVE_API_KEY', value: null }, { key: 'WEB_SEARCH_PROVIDER', value: 'brave' }]); cleanup();
    }
    // Settings and both EmailClient presentations share this writer.
    for (const presentation of ['settings', 'dialog', 'setup'] as const) {
      query = new URLSearchParams();
      const screen = render(wrap(<EmailAccountsCard isOpen onOpenChange={() => undefined} presentation={presentation} />)); await settle();
      fireEvent.click(screen.getByRole('button', { name: /Gmail/ })); await settle();
      fireEvent.click(screen.getByRole('button', { name: en.settings.emailAccounts.setup.configureOAuthApp })); await settle();
      fireEvent.change(document.querySelector('#email-google-client-id')!, { target: { value: ` fixture-google-${presentation} ` } });
      fireEvent.change(document.querySelector('#email-google-client-secret')!, { target: { value: ` fixture-secret-${presentation} ` } });
      fireEvent.click(screen.getByRole('button', { name: en.settings.emailAccounts.setup.saveAndConnect })); await settle();
      assert.deepEqual(writes.at(-1)?.patches, [{ key: 'GOOGLE_OAUTH_CLIENT_ID', value: `fixture-google-${presentation}` }, { key: 'GOOGLE_OAUTH_CLIENT_SECRET', value: `fixture-secret-${presentation}` }]); cleanup();
    }
    query = new URLSearchParams('tab=mcp&section=mcpConfig');
    const profile = {} as React.ComponentProps<typeof IntegrationsSettingsClient>['initialUserProfile'];
    const parent = render(wrap(<IntegrationsSettingsClient isAdmin initialUserProfile={profile} />)); await settle();
    fireEvent.click(parent.getByRole('button', { name: en.settings.mcpConfig.addServer })); await settle();
    fireEvent.click(parent.getByRole('button', { name: 'Fill fixture MCP' })); await settle();
    fireEvent.click(parent.getByRole('button', { name: 'Save fixture MCP' })); await settle();
    assert.deepEqual(writes.at(-1)?.patches, [{ key: 'MCP_FIXTURE_TOKEN', value: 'mcp-fixture-new' }]);
    assert.equal(JSON.parse(configRaw).mcpServers.fixture.env.TOKEN, '${MCP_FIXTURE_TOKEN}'); cleanup();
    for (const locale of ['en', 'de'] as const) {
      query = new URLSearchParams('tab=secrets');
      const screen = render(wrap(<IntegrationsSettingsClient isAdmin={false} initialUserProfile={profile} />, locale)); await settle();
      assert.equal(screen.getAllByTestId('unified-secrets').length, 1); assert.equal(screen.getByTestId('unified-secrets').getAttribute('data-language'), locale); assert.equal(screen.getByTestId('unified-secrets').getAttribute('data-admin'), 'false'); cleanup();
    }
    assert.equal(values.get('OTHER_KEY'), 'keep-other'); assert.equal(values.get('OLLAMA_API_KEY'), 'keep-ollama'); assert.equal(values.get('CANVAS_PROFILE_AGENTS__OPENAI_API_KEY'), 'keep-profile'); assert.equal(events, writes.length);
    globalThis.fetch = async () => Response.json({ success: false, error: 'fixture-denied' }, { status: 403 });
    await assert.rejects(() => patchSettingsIntegrationEnv([{ key: 'OTHER_KEY', value: null }], 'fallback-error'), /fixture-denied/); assert.equal(events, writes.length, 'failed writes do not signal an update');
    assert.deepEqual(getSecretCategories('CANVAS_MCP_A_ENV_B'), ['integrations']);
    assert.deepEqual(getSecretCategories('CANVAS_PROFILE_AGENTS__OPENAI_API_KEY'), ['agent-runtime', 'media', 'integrations']);
    assert.deepEqual(getSecretCategories('CANVAS_PROFILE_AGENTS__BRAVE_API_KEY'), ['agent-runtime', 'integrations']);
    assert.deepEqual(getSecretCategories('CANVAS_PROFILE_AGENTS__CUSTOM_UNKNOWN_KEY'), ['agent-runtime', 'integrations']);
    assert.deepEqual(getSecretCategories('CANVAS_PROFILE_SOURCE_AGENTS__OPENAI_API_KEY'), ['other']);
    console.log('Settings ENV patches: Search save/delete, Email settings/dialog/setup, MCP collector, one editor, categories, unrelated preservation and failure signals passed.');
  } finally { cleanup(); globalThis.fetch = oldFetch; internals._load = originalLoad; window.removeEventListener('canvas_secrets_updated', onUpdate); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
