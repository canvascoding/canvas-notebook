import assert from 'node:assert/strict';
import { renderToString } from 'react-dom/server';
import { CodeEditor } from '../app/components/editor/CodeEditorClient';

// Import the real client boundary and all of its static transitive dependencies
// in Node, without JSDOM, a mocked module loader, or browser globals. The actual
// CodeMirror view must remain behind the hydration gate on the server.
assert.equal(typeof window, 'undefined');
assert.equal(typeof document, 'undefined');
for (const readOnly of [false, true]) {
  const html = renderToString(<CodeEditor value="Private source is not a loading placeholder" onChange={() => {
    throw new Error('Server rendering must never mutate the document.');
  }} readOnly={readOnly} path="fixture.md" />);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-label="Loading code editor"/);
  assert.doesNotMatch(html, /Private source|cm-content|contenteditable/);
}
console.log('PASS: real CodeEditor dependency graph imports and renders safely without browser globals (editable and read-only).');
