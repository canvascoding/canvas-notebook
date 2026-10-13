import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.example.test/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const { render, cleanup, fireEvent } = await import('@testing-library/react');
  const { McpServerSettingsPanel } = await import('../app/components/settings/McpServerSettingsPanel');
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/connections')) return Response.json({ success: true, data: { connections: [] } });
    if (url.endsWith('/workspaces')) return Response.json({ success: true, data: { workspaces: [] } });
    return Response.json({ success: true, data: { desiredEnabled: false, runtimeEnabled: false,
      endpoint: 'https://canvas.example.test/mcp', capabilities: [
        { id: 'read_knowledge_source', enabled: true, available: true, scopes: ['knowledge:read'] },
        { id: 'create_knowledge_source', enabled: false, available: true, scopes: ['knowledge:write'] },
        { id: 'import_knowledge_file', enabled: false, available: true, scopes: ['knowledge:write'] },
        { id: 'create_excalidraw_scene', enabled: false, available: true, scopes: ['knowledge:write'] },
        { id: 'get_excalidraw_scene', enabled: false, available: true, scopes: ['knowledge:read'] },
        { id: 'edit_excalidraw_scene', enabled: false, available: true, scopes: ['knowledge:write'] },
      ] } });
  };
  try {
    const screen = render(<NextIntlClientProvider locale="en" timeZone="Europe/Berlin" messages={en}>
      <McpServerSettingsPanel isAdmin />
    </NextIntlClientProvider>);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const labels = en.settings.mcpServer;
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: labels.activation.label })); });
    const create = screen.getByRole('switch', { name: labels.capabilities.items.create_knowledge_source.title });
    const imported = screen.getByRole('switch', { name: labels.capabilities.items.import_knowledge_file.title });
    assert.equal(create.getAttribute('aria-checked'), 'false');
    assert.equal(imported.getAttribute('aria-checked'), 'false');
    await act(async () => { fireEvent.click(create); });
    assert.equal(create.getAttribute('aria-checked'), 'true');
    assert.equal(imported.getAttribute('aria-checked'), 'false');
    const sceneSwitches = (['create_excalidraw_scene', 'get_excalidraw_scene', 'edit_excalidraw_scene'] as const)
      .map(id => screen.getByRole('switch', { name: labels.capabilities.items[id].title }));
    assert.equal(sceneSwitches.every(control => control.getAttribute('aria-checked') === 'false'), true,
      'Activating MCP must not automatically select any new scene capability.');
    await act(async () => { fireEvent.click(sceneSwitches[1]); });
    assert.deepEqual(sceneSwitches.map(control => control.getAttribute('aria-checked')), ['false', 'true', 'false']);
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: labels.activation.label })); });
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: labels.activation.label })); });
    assert.deepEqual(sceneSwitches.map(control => control.getAttribute('aria-checked')), ['false', 'true', 'false'],
      'Reactivation preserves the explicit selection and does not add the other scene capabilities.');
    console.log('mcp-ingest-settings-ui-test: ok (activation and reactivation preserve explicit ingestion and scene selection)');
  } finally { cleanup(); globalThis.fetch = original; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
