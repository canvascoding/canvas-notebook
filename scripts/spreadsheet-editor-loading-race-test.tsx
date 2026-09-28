import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import React, { act, createRef } from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { OfficeEditorRef } from '../app/components/editor/OfficeEditor';
import type { SpreadsheetEditorRef } from '../app/components/editor/SpreadsheetEditor';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

const require = createRequire(path.join(process.cwd(), 'package.json'));
require.extensions['.css'] = () => undefined;

type GridOptions = { worksheets: { data: (string | number | boolean)[][] }[]; onchange: () => void; onload: () => void };
const grids: { options: GridOptions; data: (string | number | boolean)[][]; destroyed: boolean }[] = [];
const gridFactory = (_container: HTMLElement, options: GridOptions) => {
  const grid = { options, data: options.worksheets[0].data, destroyed: false };
  grids.push(grid);
  options.onload();
  return [{ getData: () => grid.data, getValueFromCoords: () => '', }];
};
gridFactory.destroy = (_container: HTMLElement) => {
  const grid = grids.findLast((entry) => !entry.destroyed);
  if (grid) grid.destroyed = true;
};
const spreadsheetModule = require.resolve('jspreadsheet-ce');
require(spreadsheetModule);
require.cache[spreadsheetModule]!.exports = gridFactory;

const { render, cleanup } = require('@testing-library/react') as typeof import('@testing-library/react');
const { SpreadsheetEditor } = require('./app/components/editor/SpreadsheetEditor') as typeof import('../app/components/editor/SpreadsheetEditor');
const { OfficeEditor } = require('./app/components/editor/OfficeEditor') as typeof import('../app/components/editor/OfficeEditor');

type PendingRequest = { url: string; signal: AbortSignal | null; resolve: (response: Response) => void };
const pending: PendingRequest[] = [];
globalThis.fetch = (input, init) => new Promise<Response>((resolve) => {
  pending.push({ url: String(input), signal: init?.signal ?? null, resolve });
});

const finish = async (request: PendingRequest, csv: string) => {
  await act(async () => { request.resolve(new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } })); });
};

async function main() {
  const ref = createRef<SpreadsheetEditorRef>();
  const changes: string[] = [];
  const mounted = render(<SpreadsheetEditor ref={ref} path="first.csv" sourceUrl="/first.csv" onChange={() => changes.push('first')} />);
  assert.equal(pending.length, 1);

  await act(async () => {
    mounted.rerender(<SpreadsheetEditor ref={ref} path="second.csv" sourceUrl="/second.csv" onChange={() => changes.push('second')} />);
  });
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal?.aborted, true, 'superseded request should be aborted');
  await finish(pending[1], 'new,2');
  assert.deepEqual(ref.current?.getData()?.[0].data[0], ['new', 2]);
  const currentGrid = grids.at(-1)!;

  await finish(pending[0], 'old,1');
  assert.deepEqual(ref.current?.getData()?.[0].data[0], ['new', 2], 'late old response must not replace the new document');
  assert.equal(grids.length, 1, 'late old response must not create a second grid');
  assert.equal(currentGrid.destroyed, false);

  await act(async () => {
    mounted.rerender(<SpreadsheetEditor ref={ref} path="second.csv" sourceUrl="/second.csv" onChange={() => changes.push('latest')} />);
  });
  assert.equal(pending.length, 2, 'callback-only render must not refetch the file');
  assert.equal(grids.length, 1, 'callback-only render must preserve the grid and edits');
  await act(async () => { currentGrid.options.onchange(); });
  assert.deepEqual(changes, ['latest'], 'the existing grid must call the latest parent callback');
  assert.equal(ref.current?.hasChanges(), true);

  await act(async () => {
    mounted.rerender(<SpreadsheetEditor ref={ref} path="third.csv" sourceUrl="/third.csv" onChange={() => changes.push('third')} />);
  });
  assert.equal(pending.length, 3);
  assert.equal(currentGrid.destroyed, true);
  await act(async () => { currentGrid.options.onload(); });
  assert.match(mounted.container.textContent || '', /Loading spreadsheet/, 'stale onload must not hide the new loading state');
  await finish(pending[2], 'third,3');
  assert.deepEqual(ref.current?.getData()?.[0].data[0], ['third', 3]);
  const saved = await ref.current?.save();
  assert.equal(Buffer.from((saved || '').replace(/^base64:/, ''), 'base64').toString(), 'third,3', 'saving still serializes the current grid');
  cleanup();

  const officeRef = createRef<OfficeEditorRef>();
  const officeChanges: string[] = [];
  const officeView = (onChange: () => void) => (
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <OfficeEditor ref={officeRef} path="office.csv" extension="csv" sourceUrl="/office.csv" onChange={onChange} />
    </NextIntlClientProvider>
  );
  const office = render(officeView(() => officeChanges.push('initial')));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  assert.equal(pending.length, 4, 'office wrapper should load the spreadsheet once');
  await finish(pending[3], 'office,4');
  const officeGrid = grids.at(-1)!;
  const versionBefore = officeRef.current!.changeVersion();
  await act(async () => { officeGrid.options.onchange(); });
  assert.equal(officeRef.current!.changeVersion(), versionBefore + 1);
  assert.equal(officeRef.current!.hasChanges(), true);
  assert.equal(pending.length, 4, 'office dirty-state render must not restart the spreadsheet load');
  assert.equal(officeGrid.destroyed, false);
  await act(async () => { office.rerender(officeView(() => officeChanges.push('latest'))); });
  await act(async () => { officeGrid.options.onchange(); });
  assert.deepEqual(officeChanges, ['initial', 'latest']);
  assert.equal(pending.length, 4, 'new parent callback must not restart the spreadsheet load');
  cleanup();
  dom.window.close();
  console.log('spreadsheet-editor-loading-race-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
