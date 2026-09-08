import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual, inspect } from 'node:util';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { DocumentAgent, parseDocx, repackDocx, type Document } from '@eigenpal/docx-js-editor/core';
import { validateDocxPackage } from '../app/lib/office/docx-package';
import { assessDocxEditorCompatibility } from '../app/lib/office/editor-compatibility';
import { serializeDocxForEditor } from '../app/lib/office/serialize-docx-for-editor';
import {
  createOfficeRoundtripFixture,
  OFFICE_ROUNDTRIP_NAMESPACES as NS,
  OFFICE_ROUNDTRIP_TEXT,
  type OfficeRoundtripFixtureOptions,
} from './fixtures/office-docx-roundtrip';

type XmlNode = { ns: string; local: string; attributes: Record<string, string>; children: (XmlNode | string)[] };
type PackageView = { zip: JSZip; main: XmlNode };
type Failure = { case: string; phase: string; feature: string; expected: unknown; actual: unknown };
const failures: Failure[] = [];
const diagnostics: string[] = [];

function xmlTree(xml: string): XmlNode {
  const parser = new SaxesParser({ xmlns: true });
  let root: XmlNode | undefined;
  const stack: XmlNode[] = [];
  parser.on('opentag', (tag) => {
    const node: XmlNode = { ns: tag.uri, local: tag.local, attributes: {}, children: [] };
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri !== 'http://www.w3.org/2000/xmlns/') node.attributes[`{${attribute.uri}}${attribute.local}`] = attribute.value;
    }
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root = node;
    stack.push(node);
  });
  const text = (value: string) => {
    if (!stack.length) return;
    const current = stack[stack.length - 1];
    if (value.trim() || ['t', 'delText', 'instrText'].includes(current.local)) current.children.push(value);
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => { stack.pop(); });
  parser.write(xml).close();
  assert.ok(root);
  return root;
}

function nodes(root: XmlNode, ns: string, local: string): XmlNode[] {
  return [ ...(root.ns === ns && root.local === local ? [root] : []), ...root.children.flatMap((child) => typeof child === 'string' ? [] : nodes(child, ns, local)) ];
}

function texts(root: XmlNode): string[] {
  return root.children.flatMap((child) => typeof child === 'string' ? [child] : texts(child));
}

function attribute(node: XmlNode, ns: string, local: string): string | undefined {
  return node.attributes[`{${ns}}${local}`];
}

function projectedAttributes(root: XmlNode, ns: string, local: string, attributes: [string, string][]): unknown[] {
  return nodes(root, ns, local).map((node) => Object.fromEntries(attributes.map(([uri, name]) => [name, attribute(node, uri, name)])));
}

function tableSummary(root: XmlNode): unknown[] {
  return nodes(root, NS.w, 'tbl').map((table) => ({
    rows: nodes(table, NS.w, 'tr').map((row) => nodes(row, NS.w, 'tc').map((cell) => ({
      text: nodes(cell, NS.w, 't').map((node) => texts(node).join('')),
      gridSpan: projectedAttributes(cell, NS.w, 'gridSpan', [[NS.w, 'val']]),
      shading: projectedAttributes(cell, NS.w, 'shd', [[NS.w, 'fill']]),
    }))),
    widths: projectedAttributes(table, NS.w, 'gridCol', [[NS.w, 'w']]),
    topBorder: projectedAttributes(table, NS.w, 'top', [[NS.w, 'val'], [NS.w, 'sz'], [NS.w, 'color']]),
    bottomBorder: projectedAttributes(table, NS.w, 'bottom', [[NS.w, 'val'], [NS.w, 'sz'], [NS.w, 'color']]),
    repeatingHeaders: nodes(table, NS.w, 'tblHeader').length,
  }));
}

function trackSummary(root: XmlNode): unknown {
  return Object.fromEntries(['ins', 'del'].map((kind) => [kind, nodes(root, NS.w, kind).map((node) => ({
    id: attribute(node, NS.w, 'id'), author: attribute(node, NS.w, 'author'), date: attribute(node, NS.w, 'date'),
    text: texts(node), boldRuns: nodes(node, NS.w, 'b').length,
  }))]));
}

function commentSummary(root: XmlNode): unknown {
  return nodes(root, NS.w, 'comment').map((comment) => ({
    id: attribute(comment, NS.w, 'id'), author: attribute(comment, NS.w, 'author'), initials: attribute(comment, NS.w, 'initials'), date: attribute(comment, NS.w, 'date'),
    text: texts(comment), boldRuns: nodes(comment, NS.w, 'b').length, italicRuns: nodes(comment, NS.w, 'i').length,
  }));
}

function relationships(root: XmlNode): unknown[] {
  return nodes(root, NS.rels, 'Relationship').map((node) => node.attributes);
}

async function resolvedImages(view: PackageView): Promise<unknown[]> {
  const rels = xmlTree(await view.zip.file('word/_rels/document.xml.rels')!.async('string'));
  return Promise.all(nodes(view.main, NS.a, 'blip').map(async (blip) => {
    const id = attribute(blip, NS.r, 'embed');
    const relationship = nodes(rels, NS.rels, 'Relationship').find((node) => attribute(node, '', 'Id') === id);
    const target = relationship && attribute(relationship, '', 'Target');
    const partName = target && path.posix.normalize(target.startsWith('/') ? target.slice(1) : `word/${target}`);
    const bytes = partName && await view.zip.file(partName)?.async('nodebuffer');
    return { type: relationship && attribute(relationship, '', 'Type'), contentHash: bytes ? createHash('sha256').update(bytes).digest('hex') : null };
  }));
}

function editText(document: Document, before: string, after: string): void {
  let changed = 0;
  for (const block of document.package.document.content) {
    if (block.type !== 'paragraph') continue;
    for (const content of block.content) {
      if (content.type !== 'run') continue;
      for (const child of content.content) {
        if (child.type === 'text' && child.text === before) { child.text = after; changed++; }
      }
    }
  }
  assert.equal(changed, 1, 'The fixture edit must change exactly one existing text node.');
}

function check(caseName: string, phase: string, feature: string, expected: unknown, actual: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) failures.push({ case: caseName, phase, feature, expected, actual });
}

async function openPackage(buffer: Buffer): Promise<PackageView> {
  const zip = await JSZip.loadAsync(buffer);
  const main = xmlTree(await zip.file('word/document.xml')!.async('string'));
  return { zip, main };
}

async function compareOutput(caseName: string, phase: string, baseline: PackageView, buffer: Buffer, expectedText: string, normalized: boolean): Promise<void> {
  try { await validateDocxPackage(buffer); } catch (error) {
    failures.push({ case: caseName, phase, feature: 'valid DOCX package', expected: 'valid', actual: String(error) });
  }
  const output = await openPackage(buffer);
  const initialParts = Object.keys(baseline.zip.files).filter((name) => !baseline.zip.files[name].dir).sort();
  const currentParts = Object.keys(output.zip.files).filter((name) => !output.zip.files[name].dir).sort();
  check(caseName, phase, 'all original package parts retained', [], initialParts.filter((name) => !currentParts.includes(name)));
  const mainText = nodes(output.main, NS.w, 't').map((node) => texts(node).join(''));
  check(caseName, phase, 'targeted sentence edit', 1, mainText.filter((text) => text === expectedText).length);
  check(caseName, phase, 'table cells, merges, geometry and styling', tableSummary(baseline.main), tableSummary(output.main));
  check(caseName, phase, 'image relationship resolves to original image bytes', await resolvedImages(baseline), await resolvedImages(output));
  check(caseName, phase, 'image extent', projectedAttributes(baseline.main, NS.wp, 'extent', [['', 'cx'], ['', 'cy']]), projectedAttributes(output.main, NS.wp, 'extent', [['', 'cx'], ['', 'cy']]));
  check(caseName, phase, 'image alternative description', projectedAttributes(baseline.main, NS.wp, 'docPr', [['', 'descr']]), projectedAttributes(output.main, NS.wp, 'docPr', [['', 'descr']]));
  check(caseName, phase, 'tracked changes and original author/date/deleted text', trackSummary(baseline.main), trackSummary(output.main));
  for (const name of ['commentRangeStart', 'commentRangeEnd', 'commentReference']) {
    check(caseName, phase, name, projectedAttributes(baseline.main, NS.w, name, [[NS.w, 'id']]), projectedAttributes(output.main, NS.w, name, [[NS.w, 'id']]));
  }
  for (const name of ['headerReference', 'footerReference']) {
    check(caseName, phase, name, projectedAttributes(baseline.main, NS.w, name, [[NS.w, 'type'], [NS.r, 'id']]), projectedAttributes(output.main, NS.w, name, [[NS.w, 'type'], [NS.r, 'id']]));
  }
  check(caseName, phase, 'external hyperlink', projectedAttributes(baseline.main, NS.w, 'hyperlink', [[NS.r, 'id'], [NS.w, 'tooltip']]), projectedAttributes(output.main, NS.w, 'hyperlink', [[NS.r, 'id'], [NS.w, 'tooltip']]));
  for (const name of ['_rels/.rels', 'word/_rels/document.xml.rels', 'word/header1.xml', 'word/footer1.xml', 'word/comments.xml', 'word/styles.xml']) {
    const original = baseline.zip.file(name);
    if (!original) continue;
    const current = output.zip.file(name);
    const previousTree = xmlTree(await original.async('string'));
    const currentTree = current ? xmlTree(await current.async('string')) : null;
    if (name.endsWith('.rels') && currentTree) {
      const available = relationships(currentTree);
      for (const relationship of relationships(previousTree)) check(caseName, phase, `original relationship retained: ${name}`, true, available.some((candidate) => isDeepStrictEqual(candidate, relationship)));
    } else if (name === 'word/comments.xml') {
      check(caseName, phase, 'comment text, anchors, author, initials, date and formatting', commentSummary(previousTree), currentTree && commentSummary(currentTree));
    } else {
      check(caseName, phase, `semantic XML: ${name}`, previousTree, currentTree);
    }
  }
  for (const name of ['word/media/pixel.png', 'word/vendor/opaque.bin', 'customXml/item1.xml']) {
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    check(caseName, phase, `unchanged media/unknown part: ${name}`, digest(await baseline.zip.file(name)!.async('nodebuffer')), output.zip.file(name) ? digest(await output.zip.file(name)!.async('nodebuffer')) : null);
  }
  for (const [ns, name] of [[NS.w, 'customXml'], [NS.vendor, 'extension'], [NS.w, 'contextualSpacing'], [NS.vendor, 'rule']]) {
    check(caseName, phase, `unmodeled main XML: ${name}`, nodes(baseline.main, ns, name), nodes(output.main, ns, name));
  }
  const originalMedia = initialParts.filter((name) => name.startsWith('word/media/')).length;
  const outputMedia = currentParts.filter((name) => name.startsWith('word/media/')).length;
  if (normalized) check(caseName, phase, 'unchanged images do not accumulate duplicate ZIP entries', originalMedia, outputMedia);
  if (outputMedia !== originalMedia) diagnostics.push(`${caseName} / ${phase}: media entries ${originalMedia} → ${outputMedia}; bytes ${buffer.length}.`);
}

async function scenario(caseName: string, options: OfficeRoundtripFixtureOptions, serializer: 'normalized' | 'raw' | 'agent' = 'normalized'): Promise<void> {
  const buffer = await createOfficeRoundtripFixture(options);
  await validateDocxPackage(buffer);
  const blocked = options.unknownBody || options.unknownParagraphProperty;
  const compatibility = await assessDocxEditorCompatibility(buffer);
  assert.equal(compatibility.editable, !blocked, `${caseName}: editing eligibility must match demonstrated serializer coverage.`);
  const initialFailureCount = failures.length;
  const baseline = await openPackage(buffer);
  const model = await parseDocx(buffer, { preloadFonts: false });
  assert.ok(model.originalBuffer, 'Parsing must retain the original ZIP for subsequent autosaves.');
  const serialize = async (document: Document) => {
    const before = structuredClone(document);
    const bytes = Buffer.from(await (serializer === 'agent' ? DocumentAgent.fromDocument(document).toBuffer() : serializer === 'normalized' ? serializeDocxForEditor(document) : repackDocx(document)));
    if (serializer === 'normalized') assert.deepEqual(document, before, 'Saving must not mutate the editor snapshot or its image sources.');
    if (!blocked) assert.equal((await assessDocxEditorCompatibility(bytes)).editable, true, 'A supported document must remain editable after saving.');
    return bytes;
  };
  editText(model, OFFICE_ROUNDTRIP_TEXT, 'First autosave edit.');
  // This also checks the Maps/ArrayBuffer survive the IndexedDB structured clone.
  const first = await serialize(structuredClone(model));
  await compareOutput(caseName, 'first save', baseline, first, 'First autosave edit.', serializer === 'normalized');
  editText(model, 'First autosave edit.', 'Second autosave edit.');
  const second = await serialize(structuredClone(model));
  await compareOutput(caseName, 'second save with original source buffer', baseline, second, 'Second autosave edit.', serializer === 'normalized');
  const reopened = await parseDocx(first, { preloadFonts: false });
  editText(reopened, 'First autosave edit.', 'Edit after reopening.');
  const afterReopen = await serialize(structuredClone(reopened));
  await compareOutput(caseName, 'save after reopening first output', baseline, afterReopen, 'Edit after reopening.', serializer === 'normalized');
  if (blocked) {
    const expectedLosses = failures.splice(initialFailureCount);
    const expectedNames = options.unknownBody ? ['unmodeled main XML: customXml', 'unmodeled main XML: extension'] : ['unmodeled main XML: rule'];
    assert.equal(expectedLosses.length, expectedNames.length * 3, 'The regression fixture must reproduce the exact loss blocked by the compatibility gate.');
    for (const failure of expectedLosses) assert.ok(expectedNames.includes(failure.feature));
    process.stdout.write(`BLOCKED ${caseName}: raw serializer drops ${expectedNames.join(', ')} in all three save phases; compatibility gate refuses editing.\n`);
  }
  process.stdout.write(`Checked ${caseName}: first save, repeated autosave, reopen/save.\n`);
}

async function main(): Promise<void> {
  await scenario('tables/images/headers/footers/unknown package parts', { comments: false, trackedChanges: false });
  await scenario('comments', { comments: true, trackedChanges: false });
  await scenario('tracked changes', { comments: false, trackedChanges: true });
  await scenario('all representative modeled features', {});
  await scenario('unknown body markup', { unknownBody: true }, 'raw');
  await scenario('unknown properties in edited paragraph', { unknownParagraphProperty: true }, 'raw');
  await scenario('DocumentAgent.toBuffer with all modeled features', {}, 'agent');
  for (const failure of failures) {
    process.stderr.write(`FAIL ${failure.case} / ${failure.phase} / ${failure.feature}\n`);
    process.stderr.write(`Expected: ${inspect(failure.expected, { depth: 3, maxArrayLength: 5, breakLength: 140 }).slice(0, 1500)}\nActual: ${inspect(failure.actual, { depth: 3, maxArrayLength: 5, breakLength: 140 }).slice(0, 1500)}\n`);
  }
  for (const diagnostic of diagnostics) process.stdout.write(`NOTE ${diagnostic}\n`);
  assert.equal(failures.length, 0, 'DOCX serializer fidelity failures require a safe editing policy before enabling autosave for these documents.');
  process.stdout.write('Office DOCX roundtrip: all semantic preservation checks passed.\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
