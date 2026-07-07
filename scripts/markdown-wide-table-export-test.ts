import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';

import { formatWideTablesForPagedExport } from '../app/lib/pdf/markdown-wide-tables';

const narrowTable = `
  <table>
    <thead><tr><th>A</th><th>B</th></tr></thead>
    <tbody><tr><td>1</td><td>2</td></tr></tbody>
  </table>
`;

const wideTable = `
  <table>
    <thead>
      <tr>
        <th>Feature</th>
        <th>Canvas Notebook</th>
        <th>Obsidian</th>
        <th>Notion</th>
        <th>Codex</th>
        <th>Gemini Spark</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Markdown editor</td>
        <td>Notion-like block editing</td>
        <td>Basic</td>
        <td>Formatted cloud editor</td>
        <td>Limited</td>
        <td>Google Docs bridge</td>
      </tr>
    </tbody>
  </table>
`;

const html = formatWideTablesForPagedExport(`
  <p>Before</p>
  ${narrowTable}
  <p>Between</p>
  ${wideTable}
  <p>After</p>
`);

const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
const document = dom.window.document;
const wideSections = Array.from(document.querySelectorAll('section.markdown-wide-table-page'));
const tables = Array.from(document.querySelectorAll('table'));

assert.equal(wideSections.length, 1);
assert.equal(tables.length, 2);
assert.equal(document.querySelectorAll('table.markdown-wide-table').length, 1);
assert.equal(wideSections[0].querySelectorAll('th').length, 6);
assert.equal(document.body.textContent?.includes('Before'), true);
assert.equal(document.body.textContent?.includes('Between'), true);
assert.equal(document.body.textContent?.includes('After'), true);

const bodyChildren = Array.from(document.body.children);
const betweenIndex = bodyChildren.findIndex((element) => element.textContent?.includes('Between'));
const wideSectionIndex = bodyChildren.findIndex((element) => element.classList.contains('markdown-wide-table-page'));
const afterIndex = bodyChildren.findIndex((element) => element.textContent?.includes('After'));

assert.ok(betweenIndex > -1);
assert.ok(wideSectionIndex > betweenIndex);
assert.ok(afterIndex > wideSectionIndex);

console.log('markdown-wide-table-export-test: ok');
