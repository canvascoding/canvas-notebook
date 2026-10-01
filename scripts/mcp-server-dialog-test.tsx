import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { McpServerDraft } from '../app/components/settings/McpServerDialog';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://notebook.example.test/settings', pretendToBeVisual: true });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'Event', 'CustomEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });

async function main() {
  const { render, cleanup, fireEvent } = await import('@testing-library/react');
  const { McpServerDialog, toMcpServerDraft, createBlankMcpServerDraft, createMcpServerDraftFromConnector, collectMcpEnvEntries, updateMcpConfigRawServer } = await import('../app/components/settings/McpServerDialog');
  const server = {
    enabled: false,
    url: 'https://service.example.test/mcp',
    auth: 'oauth',
    bearerTokenEnv: 'MCP_EXISTING_BEARER',
    headers: { Authorization: '${MCP_EXISTING_HEADER}', 'X-Empty': '' },
    headersFromEnv: { 'X-Tenant': 'MCP_EXISTING_TENANT' },
    oauth: { issuer: 'https://issuer.example.test', authorizationUrl: 'https://issuer.example.test/authorize', tokenUrl: 'https://issuer.example.test/token', clientId: 'fixture-client', scopes: ['read', 'write'], redirectUri: 'https://notebook.example.test/api/mcp/oauth/callback', futureOAuth: { keep: true } },
    connectionId: 'fixture-connection',
    ownerUserId: 'fixture-owner',
    serverDefinitionId: 'fixture-definition',
    authVersion: 7,
    futureOption: { nested: ['keep', 2] },
  };
  const raw = JSON.stringify({ futureRoot: { keep: true }, mcpServers: { existing: server } });
  const save = (draft: McpServerDraft, content = raw, originalName = 'existing') => JSON.parse(updateMcpConfigRawServer(content, draft, originalName));
  const draft = toMcpServerDraft('existing', server);
  assert.deepEqual(save(draft).mcpServers.existing, server, 'unchanged form is lossless for all config fields');
  const renamed = save({ ...draft, name: 'renamed' });
  assert.deepEqual(renamed.mcpServers.renamed, server, 'rename preserves OAuth, references, unknown fields and connection identity');
  assert.equal(renamed.mcpServers.existing, undefined);
  assert.deepEqual(renamed.futureRoot, { keep: true });
  const changedUrl = save({ ...draft, url: 'https://service.example.test/new' });
  assert.deepEqual(changedUrl.mcpServers.existing, { ...server, url: 'https://service.example.test/new' });
  const concurrent = JSON.stringify({ mcpServers: { existing: { ...server, connectionId: 'latest-connection', futureOption: { latest: true }, headers: { 'X-New': '${MCP_CONCURRENT}' }, oauth: { ...server.oauth, futureOAuth: { latest: true }, anotherFutureOAuth: 42 } } } });
  const merged = save({ ...draft, url: 'https://service.example.test/new', oauth: { ...draft.oauth, tokenUrl: 'https://issuer.example.test/new-token' } }, concurrent).mcpServers.existing;
  assert.equal(merged.connectionId, 'latest-connection');
  assert.deepEqual(merged.futureOption, { latest: true });
  assert.deepEqual(merged.headers, { 'X-New': '${MCP_CONCURRENT}' });
  assert.deepEqual(merged.oauth.futureOAuth, { latest: true });
  assert.equal(merged.oauth.anotherFutureOAuth, 42);
  assert.equal(merged.oauth.tokenUrl, 'https://issuer.example.test/new-token');
  const noAuth = save({ ...draft, auth: 'none' }).mcpServers.existing;
  assert.equal(noAuth.auth, 'none'); assert.equal(noAuth.oauth, undefined); assert.equal(noAuth.bearerTokenEnv, undefined);
  assert.deepEqual(noAuth.headers, server.headers, 'advanced headers change only through their explicit controls');
  const token = save({ ...draft, auth: 'token', bearerTokenValue: 'fixture-new-token' }).mcpServers.existing;
  assert.equal(token.auth, 'none'); assert.equal(token.oauth, undefined); assert.equal(token.bearerTokenEnv, server.bearerTokenEnv);
  assert.equal(JSON.stringify(token).includes('fixture-new-token'), false, 'token value is never serialized into MCP JSON');
  assert.deepEqual(collectMcpEnvEntries({ ...draft, auth: 'token', bearerTokenValue: 'fixture-new-token' }), [{ key: server.bearerTokenEnv, value: 'fixture-new-token' }]);
  assert.throws(() => save({ ...draft, name: 'occupied' }, JSON.stringify({ mcpServers: { existing: server, occupied: { url: 'https://other.example.test/mcp' } } })), /already exists/);

  const local = { enabled: true, command: 'node', args: ['--flag', ' spaces matter ', ''], env: { TOKEN: '${MCP_LOCAL_TOKEN}', EMPTY: '', PORT: 42 }, envPassthrough: ['PATH'], cwd: '/fixture/workspace', connectionId: 'local-connection', futureLocal: { keep: true } };
  const localDraft = toMcpServerDraft('local', local);
  const localRaw = JSON.stringify({ mcpServers: { local } });
  assert.deepEqual(save({ ...localDraft, name: 'local-renamed' }, localRaw, 'local').mcpServers['local-renamed'], local, 'hidden local configuration survives basic edits exactly');
  const editedArgs = save({ ...localDraft, args: [...localDraft.args, '--new'] }, localRaw, 'local').mcpServers.local;
  assert.deepEqual(editedArgs.args, ['--flag', ' spaces matter ', '', '--new']);
  const remote = save({ ...localDraft, mode: 'http', url: 'https://remote.example.test/mcp' }, localRaw, 'local').mcpServers.local;
  assert.equal(remote.command, undefined); assert.equal(remote.env, undefined); assert.equal(remote.connectionId, 'local-connection');
  const templateDraft = createMcpServerDraftFromConnector({ name: 'template', env: ['TOKEN'] }, { mcpServers: { template: { command: 'npx', args: ['fixture'], futureTemplate: true } } });
  const template = JSON.parse(updateMcpConfigRawServer('{"mcpServers":{}}', { ...templateDraft, env: templateDraft.env.map(entry => ({ ...entry, value: 'fixture-template-secret' })) })).mcpServers.template;
  assert.equal(template.futureTemplate, true); assert.equal(template.env.TOKEN, '${TOKEN}');
  const blank = createBlankMcpServerDraft();
  assert.equal(blank.mode, 'http'); assert.equal(blank.auth, 'oauth');

  function Fixture({ initial, developerMode, open = true, editingServerName, error, errorCode }: { initial: McpServerDraft; developerMode?: boolean; open?: boolean; editingServerName?: string; error?: string; errorCode?: string }) {
    const [current, setCurrent] = useState(initial);
    return <McpServerDialog open={open} onOpenChange={() => undefined} draft={current} onDraftChange={patch => setCurrent(value => ({ ...value, ...patch }))} onSave={() => undefined} isSaving={false} developerMode={developerMode} editingServerName={editingServerName} error={error} errorCode={errorCode} />;
  }
  const wrap = (child: React.ReactNode, locale: 'en' | 'de') => <NextIntlClientProvider locale={locale} timeZone="Europe/Berlin" messages={locale === 'en' ? en : de}>{child}</NextIntlClientProvider>;
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
  try {
    for (const locale of ['en', 'de'] as const) {
      const labels = (locale === 'en' ? en : de).settings.mcpConfig;
      const ordinary = render(wrap(<Fixture initial={blank} />, locale)); await settle();
      assert.ok(ordinary.getByLabelText(labels.name));
      assert.ok(ordinary.getByLabelText(labels.serverAddress));
      assert.ok(ordinary.getByRole('tab', { name: labels.authOAuth }));
      assert.equal(ordinary.queryByRole('button', { name: labels.developerOptions }), null);
      assert.equal(document.querySelector('#mcp-command'), null);
      assert.equal(document.querySelector('#mcp-oauth-tokenUrl'), null);
      assert.equal(ordinary.queryByText(labels.headers), null);
      fireEvent.mouseDown(ordinary.getByRole('tab', { name: labels.authToken }), { button: 0, ctrlKey: false }); await settle();
      assert.equal(ordinary.getByLabelText(labels.authToken).getAttribute('type'), 'password');
      assert.ok(ordinary.getByText(labels.tokenStoredSecurely));
      assert.equal(document.body.textContent?.includes('Canvas-Secrets.env'), false);
      assert.equal(document.body.textContent?.includes('MCP_SERVER_'), false);
      cleanup();

      const storageFailure = render(wrap(<Fixture initial={blank} error="DO_NOT_SHOW_KEY_SOURCE" errorCode="master_key_missing" />, locale)); await settle();
      assert.ok(storageFailure.getByText(labels.secureStorageUnavailable));
      assert.ok(storageFailure.getByText(labels.secureStorageContactAdmin));
      assert.equal(storageFailure.getByRole('link', { name: labels.openSecrets }).getAttribute('href'), '/settings?tab=secrets');
      assert.equal(document.body.textContent?.includes('DO_NOT_SHOW_KEY_SOURCE'), false);
      cleanup();

      const developer = render(wrap(<Fixture initial={draft} developerMode editingServerName="existing" />, locale)); await settle();
      const expand = developer.getByRole('button', { name: labels.developerOptions });
      assert.equal(expand.getAttribute('aria-expanded'), 'false');
      assert.equal(document.querySelector('#mcp-oauth-tokenUrl'), null);
      fireEvent.click(expand); await settle();
      assert.equal(expand.getAttribute('aria-expanded'), 'true');
      assert.equal((document.querySelector('#mcp-oauth-tokenUrl') as HTMLInputElement).value, server.oauth.tokenUrl);
      assert.ok(developer.getByText(labels.headers));
      developer.rerender(wrap(<Fixture initial={draft} developerMode={false} editingServerName="existing" />, locale)); await settle();
      assert.equal(document.querySelector('#mcp-oauth-tokenUrl'), null);
      developer.rerender(wrap(<Fixture initial={draft} developerMode editingServerName="existing" />, locale)); await settle();
      assert.equal(developer.getByRole('button', { name: labels.developerOptions }).getAttribute('aria-expanded'), 'false');
      cleanup();

      const ordinaryLocal = render(wrap(<Fixture initial={localDraft} editingServerName="local" />, locale)); await settle();
      assert.ok(ordinaryLocal.getByText(labels.localConnectionSummary));
      assert.equal(document.querySelector('#mcp-url'), null);
      assert.equal(document.querySelector('#mcp-command'), null);
      assert.equal(document.body.textContent?.includes('MCP_LOCAL_TOKEN'), false);
      assert.equal((document.querySelector('#mcp-local-credential-0') as HTMLInputElement).type, 'password');
      cleanup();
    }
    console.log('MCP dialog: lossless edits, concurrent metadata, explicit auth/transport changes, central token references, templates, and simple/developer UI in EN/DE passed.');
  } finally { cleanup(); dom.window.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
