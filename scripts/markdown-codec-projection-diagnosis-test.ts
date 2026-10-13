import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { createRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { createCanvasMarkedInstance } from '../app/lib/markdown/core/canvas-marked';
import { diagnoseRichMarkdownSnapshot } from './helpers/rich-markdown-projection-diagnosis';
import { nativeListTextFixture, nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

const cases = [
  { name: 'soft LF', text: 'A\nB', projected: 'A\nB', available: true },
  { name: 'one space before LF', text: 'A \nB', projected: 'A \nB', available: true },
  { name: 'hard-break-like whitespace', text: 'A  \nB', projected: 'A  \nB', available: true },
  { name: 'boundary spaces', text: ' A ', projected: ' A ', available: true },
  { name: 'nonbreaking space', text: 'A\u00a0B', projected: 'A\u00a0B', available: true },
  { name: 'inline tab', text: 'A\tB', projected: 'A\tB', available: true },
  { name: 'tab before LF', text: 'A\t\nB', projected: 'A\t\nB', available: true },
  { name: 'bare CR', text: 'A\rB', projected: 'A\rB', available: true },
  { name: 'CRLF', text: 'A\r\nB', projected: 'A\r\nB', available: true },
];

for (const format of ['tiptap_xml', 'tiptap_blocks'] as const) {
  for (const fixture of cases) test(`${format}: ${fixture.name} distinguishes native validity from projection`, () => {
    const doc = nativeListTextFixture(fixture.text, format);
    let reparsed: Y.Doc | null = null;
    try {
      const snapshot = Y.encodeStateAsUpdate(doc);
      const vector = Y.encodeStateVector(doc);
      const report = diagnoseRichMarkdownSnapshot(snapshot);
      assert.equal(report.schema, 'valid');
      assert.equal(report.blockAdmission, format === 'tiptap_blocks' ? 'valid' : null);
      assert.equal(report.projection, fixture.available ? 'available' : 'roundtrip_unstable');
      assert.equal(report.nativeEquivalent, fixture.available);
      assert.equal(report.serialization, 'ok');
      assert.deepEqual(report.evidenceUnchanged, { inputBytes: true, hydratedState: true, stateVector: true });
      assert.deepEqual(Y.encodeStateAsUpdate(doc), snapshot);
      assert.deepEqual(Y.encodeStateVector(doc), vector);
      assert.deepEqual(diagnoseRichMarkdownSnapshot(snapshot), report, 'binary replay is deterministic');
      reparsed = createRichMarkdownYDoc(richMarkdownFromYDoc(doc));
      const text = readRichDocumentJson(reparsed).content![0].content![0].content![0].content!
        .map((node) => node.text ?? '').join('');
      assert.equal(text, fixture.projected, 'records the precise synthetic loss, not a presumed production cause');
    } finally { reparsed?.destroy(); doc.destroy(); }
  });
}

test('Marked localizes tab expansion to the list tokenizer and CR conversion to the lexer', () => {
  const parser = createCanvasMarkedInstance();
  const paragraph = parser.lexer('A\tB')[0];
  const list = parser.lexer('- A\tB')[0];
  assert(paragraph.type === 'paragraph');
  assert.equal(paragraph.text, 'A\tB');
  assert(list.type === 'list');
  assert.equal(list.items[0].text, 'A B');
  const carriageReturn = parser.lexer('A\rB')[0];
  assert(carriageReturn.type === 'paragraph');
  assert.equal(carriageReturn.text, 'A\nB');
});

test('schema-invalid overlapping code/bold marks are distinct from a valid unprojectable document', () => {
  const doc = nativeListTextFixture('Synthetic text', 'tiptap_xml');
  try {
    const list = doc.getXmlFragment('body').get(0) as Y.XmlElement;
    const item = list.get(0) as Y.XmlElement;
    const paragraph = item.get(0) as Y.XmlElement;
    const text = paragraph.get(0) as Y.XmlText;
    text.format(0, text.length, { code: {}, bold: {} });
    const report = diagnoseRichMarkdownSnapshot(Y.encodeStateAsUpdate(doc));
    assert.equal(report.schema, 'invalid');
    assert.equal(report.projection, 'schema_invalid');
    assert.equal(report.serialization, 'not_checked');
    assert.deepEqual(report.evidenceUnchanged, { inputBytes: true, hydratedState: true, stateVector: true });
  } finally { doc.destroy(); }
});

test('diagnostic output never contains document content, IDs, frontmatter, or paths', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'canvas-codec-private-'));
  const filename = path.join(directory, 'PRIVATE-FILENAME.bin');
  const privateText = 'PRIVATE-BODY-SENTINEL\tEND';
  const privateMetadata = '---\ntitle: PRIVATE-METADATA-SENTINEL\n---\n';
  const doc = nativeTableWidthFixture('tiptap_blocks', privateText);
  doc.getText('frontmatter').insert(0, privateMetadata);
  try {
    const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc));
    await writeFile(filename, snapshot, { mode: 0o600 });
    const output = spawnSync(process.execPath, ['--import', 'tsx', '--conditions=react-server',
      'scripts/diagnose-rich-markdown-snapshot.ts', filename], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(output.status, 0);
    const report = JSON.parse(output.stdout) as ReturnType<typeof diagnoseRichMarkdownSnapshot>;
    assert.equal(report.projection, 'roundtrip_unstable');
    for (const secret of [privateText, 'PRIVATE-BODY-SENTINEL', 'PRIVATE-METADATA-SENTINEL', filename, 'fixture-paragraph']) {
      assert(!`${output.stdout}${output.stderr}`.includes(secret), 'private material must not be printed');
    }
    assert.deepEqual(await readFile(filename), snapshot, 'the CLI must not write back its input');
  } finally { doc.destroy(); await rm(directory, { recursive: true, force: true }); }
});

for (const format of ['tiptap_xml', 'tiptap_blocks'] as const) test(`${format}: native table widths remain a real projection failure`, () => {
  const doc = nativeTableWidthFixture(format);
  try {
    const report = diagnoseRichMarkdownSnapshot(Y.encodeStateAsUpdate(doc));
    assert.equal(report.schema, 'valid');
    assert.equal(report.blockAdmission, format === 'tiptap_blocks' ? 'valid' : null);
    assert.equal(report.projection, 'roundtrip_unstable');
    assert.equal(report.nativeEquivalent, false);
    assert.deepEqual(report.nativeText, report.reparsedText, 'only native width attributes are lost');
    assert.deepEqual(report.evidenceUnchanged, { inputBytes: true, hydratedState: true, stateVector: true });
  } finally { doc.destroy(); }
});

test('malformed, unsupported, and incomplete snapshots cannot look like successful projections', () => {
  assert.equal(diagnoseRichMarkdownSnapshot(Uint8Array.of(255)).decode, 'invalid');
  const unsupported = new Y.Doc();
  const source = new Y.Doc();
  try {
    unsupported.getText('content').insert(0, 'Private text');
    const unsupportedReport = diagnoseRichMarkdownSnapshot(Y.encodeStateAsUpdate(unsupported));
    assert.equal(unsupportedReport.representation, 'unsupported');
    assert.equal(unsupportedReport.projection, 'not_checked');
    source.getText('content').insert(0, 'Initial');
    const vector = Y.encodeStateVector(source);
    source.getText('content').insert(0, 'Later');
    const incompleteReport = diagnoseRichMarkdownSnapshot(Y.encodeStateAsUpdate(source, vector));
    assert.equal(incompleteReport.completeUpdate, false);
    assert.equal(incompleteReport.projection, 'not_checked');
  } finally { unsupported.destroy(); source.destroy(); }
});

test('all snapshot bytes must be consumed; a valid update followed by garbage is invalid', () => {
  const doc = nativeListTextFixture('Synthetic text', 'tiptap_blocks');
  try {
    const snapshot = Y.encodeStateAsUpdate(doc);
    const trailing = Uint8Array.from([...snapshot, 255, 0, 42]);
    const report = diagnoseRichMarkdownSnapshot(trailing);
    assert.equal(report.decode, 'invalid');
    assert.equal(report.projection, 'not_checked');
  } finally { doc.destroy(); }
});

test('a filesystem error cannot echo the private snapshot path', () => {
  const secretPath = '/PRIVATE-MISSING-SNAPSHOT-SENTINEL/update.bin';
  const output = spawnSync(process.execPath, ['--import', 'tsx', '--conditions=react-server',
    'scripts/diagnose-rich-markdown-snapshot.ts', secretPath], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(output.status, 2);
  assert(!`${output.stdout}${output.stderr}`.includes(secretPath));
  assert.match(output.stderr, /snapshot_unavailable/u);
});
