import assert from 'node:assert/strict';
import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { NotebookSurfaceMount } from '../app/components/notebook/NotebookSurfaceMount';

async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let starts = 0;
  let stops = 0;
  function Surface() {
    const [draft] = useState('keep this draft');
    useEffect(() => { starts += 1; return () => { stops += 1; }; }, []);
    return <span>{draft}</span>;
  }
  const root = createRoot(document.getElementById('root')!);
  const render = async (active: boolean, workspace = 'w1') => act(async () => {
    root.render(<NotebookSurfaceMount active={active} key={workspace}><Surface /></NotebookSurfaceMount>);
  });
  await render(false);
  assert.equal(starts, 0, 'hidden initial surface does not start data loading');
  await render(true);
  assert.equal(starts, 1);
  await render(false);
  await render(true);
  assert.equal(starts, 1, 'switching back does not reload the surface');
  assert.equal(stops, 0);
  assert.match(document.body.textContent ?? '', /keep this draft/);
  await render(false, 'w2');
  assert.equal(stops, 1, 'workspace switch resets previous surface ownership');
  assert.equal(starts, 1);
  await act(async () => root.unmount());
  dom.window.close();
  console.log('notebook-surface-mount-test: ok');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
