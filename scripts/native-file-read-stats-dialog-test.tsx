import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import ts from 'typescript';
import messages from '../messages/en.json';
import type { FileNode } from '../app/lib/files/types';

type Props = { node: FileNode | null; open: boolean; onOpenChange: (open: boolean) => void };
let FileInfoDialog: React.ComponentType<Props>;
let dom: JSDOM;
const priorGlobals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
const originalTimezone = process.env.TZ;
const fetched: string[] = [];

// Compile the actual application component, keeping its real formatter,
// NextIntl hooks, icons, Radix Dialog and UI components. Only the HTTP header
// transport import is replaced; the tests install a local /files/info response.
async function loadActualDialog(): Promise<React.ComponentType<Props>> {
  const filename = path.resolve('app/components/file-browser/FileInfoDialog.tsx');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {} as { FileInfoDialog: React.ComponentType<Props> };
  new Function('require', 'module', 'exports', source)(
    (name: string) => name === '@/app/lib/files/client' ? { workspaceHeaders: () => ({}) } : load(name),
    { exports }, exports,
  );
  return exports.FileInfoDialog;
}

function rendered(node: FileNode, open: boolean) {
  return (
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileInfoDialog node={node} open={open} onOpenChange={() => undefined} />
    </NextIntlClientProvider>
  );
}

before(async () => {
  process.env.TZ = 'UTC';
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test', pretendToBeVisual: true });
  const globals: Record<string, unknown> = { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) {
    priorGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globalThis.fetch = async input => {
    const url = String(input); fetched.push(url);
    assert.equal(url, '/api/files/info?path=note.md');
    // No replacement metadata: the real component displays its supplied node.
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  };
  FileInfoDialog = await loadActualDialog();
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of priorGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom?.window.close();
  if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone;
});

const nativeNode = (fields: Partial<FileNode> = {}): FileNode => ({ name: 'note.md', path: 'note.md', type: 'file', ...fields });

test('the real closed FileInfoDialog reproduces the legacy native ISO timestamp crash', () => {
  const legacy = nativeNode({ modified: '2026-10-13T12:00:00.000Z' as unknown as number, size: null as unknown as number });
  const requests = fetched.length;
  assert.throws(() => renderToString(rendered(legacy, false)), { name: 'RangeError', message: 'Invalid time value' });
  assert.equal(fetched.length, requests);
});

test('the real closed dialog accepts epoch seconds and genuine absent native metadata without fetching', () => {
  const requests = fetched.length;
  for (const node of [nativeNode({ modified: Date.UTC(2026, 9, 13, 12) / 1000, size: 1024 }), nativeNode()]) {
    assert.equal(renderToString(rendered(node, false)), '');
  }
  assert.equal(fetched.length, requests);
});

async function inspectOpenDialog(node: FileNode, check: (fields: Map<string, string>) => void): Promise<void> {
  const container = document.createElement('div'); document.body.append(container);
  const root: Root = createRoot(container); const requests = fetched.length;
  try {
    await act(async () => { root.render(rendered(node, true)); await new Promise(resolve => setImmediate(resolve)); });
    const dialog = document.querySelector('[role="dialog"]'); assert(dialog, 'The real Radix portal must mount an open dialog.');
    const fields = new Map<string, string>();
    for (const row of dialog.querySelectorAll('dl > div')) {
      const label = row.querySelector('dt')?.textContent?.trim(); const value = row.querySelector('dd')?.textContent?.trim();
      assert(label && value); fields.set(label, value);
    }
    assert.equal(fields.size, 6); check(fields); assert.equal(fetched.length, requests + 1);
  } finally {
    // Radix restores focus in a zero-delay task. Drain that actual cleanup
    // before restoring JSDOM globals, rather than replacing the focus behavior.
    await act(async () => { root.unmount(); await new Promise(resolve => setTimeout(resolve, 0)); });
    container.remove();
    assert.equal(document.querySelector('[role="dialog"]'), null);
  }
}

test('an actual open dialog displays the durable epoch-second date and known exported bytes', async () => {
  await inspectOpenDialog(nativeNode({ modified: Date.UTC(2026, 9, 13, 12) / 1000, size: 1024 }), fields => {
    assert.equal(fields.get('Last modified'), 'Oct 13, 2026, 12:00 PM');
    assert.equal(fields.get('Created'), 'Not available');
    assert.equal(fields.get('File size'), '1.0KB (1,024 bytes)');
    assert.equal(fields.get('File name'), 'note.md');
  });
});

test('an actual open dialog shows unavailable for unknown native size and dates, while zero bytes stays known', async () => {
  await inspectOpenDialog(nativeNode(), fields => {
    for (const label of ['Last modified', 'Created', 'File size']) assert.equal(fields.get(label), 'Not available');
  });
  await inspectOpenDialog(nativeNode({ size: 0 }), fields => {
    assert.equal(fields.get('File size'), '0B (0 bytes)');
    assert.equal(fields.get('Last modified'), 'Not available');
  });
});
