import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { parseDocx, type BlockContent, type Image } from '@eigenpal/docx-js-editor/core';
import { assessDocxEditorCompatibility } from '../app/lib/office/editor-compatibility';
import { serializeDocxForEditor } from '../app/lib/office/serialize-docx-for-editor';
import { DOCX_PACKAGE_LIMITS, DocxPackageValidationError, validateDocxPackage } from '../app/lib/office/docx-package';
import { createOfficeRoundtripFixture, OFFICE_ROUNDTRIP_NAMESPACES as NS, OFFICE_ROUNDTRIP_PNG } from './fixtures/office-docx-roundtrip';

function drawingImages(blocks: BlockContent[]): Image[] {
  return blocks.flatMap((block) => block.type === 'table' ? block.rows.flatMap((row) => row.cells.flatMap((cell) => drawingImages(cell.content)))
    : block.type === 'paragraph' ? block.content.flatMap((part) => part.type === 'run' ? part.content.flatMap((item) => item.type === 'drawing' ? [item.image] : []) : []) : []);
}

function bluePixelPng(): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0);
    result.write(name, 4, 'ascii');
    data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
    return result;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

async function modifyPart(name: string, replace: (xml: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await createOfficeRoundtripFixture());
  zip.file(name, replace(await zip.file(name)!.async('string')));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function assertReadOnly(buffer: Buffer): Promise<void> {
  await validateDocxPackage(buffer);
  const result = await assessDocxEditorCompatibility(buffer);
  assert.equal(result.editable, false);
  assert.ok(result.reasons.length > 0);
}

const tests: [string, () => Promise<void>][] = [
  ['allows the representative editable subset and unchanged opaque package parts', async () => {
    assert.deepEqual(await assessDocxEditorCompatibility(await createOfficeRoundtripFixture()), { editable: true, reasons: [] });
    const zip = await JSZip.loadAsync(await createOfficeRoundtripFixture());
    zip.file('customXml/unknown-extra.xml', '<x:anything xmlns:x="urn:unknown"><x:privateMetadata x:custom="keep"/></x:anything>');
    assert.deepEqual(await assessDocxEditorCompatibility(await zip.generateAsync({ type: 'nodebuffer' })), { editable: true, reasons: [] });
  }],
  ['blocks unmodeled main XML, unknown attributes and unsupported context instead of dropping them', async () => {
    await assertReadOnly(await createOfficeRoundtripFixture({ unknownBody: true }));
    await assertReadOnly(await createOfficeRoundtripFixture({ unknownParagraphProperty: true }));
    await assertReadOnly(await modifyPart('word/document.xml', (xml) => xml.replace('w14:paraId="10000001"', 'w14:paraId="10000001" vendor:reviewFlag="keep"')));
    await assertReadOnly(await modifyPart('word/document.xml', (xml) => xml.replace('<w:pPr>', '<w:pPr><w:lang w:val="de-DE"/>')));
    await assertReadOnly(await modifyPart('word/document.xml', (xml) => xml.replace('<w:body>', '<w:body><w:comment w:id="99"/>')));
    await assertReadOnly(await modifyPart('word/document.xml', (xml) => xml.replace('</w:body>', '<?custom-workflow preserve="yes"?></w:body>')));
  }],
  ['blocks unsupported header, footer and comment content because those parts are also rewritten', async () => {
    await assertReadOnly(await modifyPart('word/header1.xml', (xml) => xml.replace('</w:hdr>', '<w:customXml w:uri="urn:test" w:element="preserve"><w:p><w:r><w:t>Header custom data</w:t></w:r></w:p></w:customXml></w:hdr>')));
    await assertReadOnly(await modifyPart('word/footer1.xml', (xml) => xml.replace('<w:r>', '<w:r><w:rPr><w:lang w:val="de-DE"/></w:rPr>')));
    await assertReadOnly(await modifyPart('word/comments.xml', (xml) => xml.replace('<w:comment ', '<w:comment w:custom="keep" ')));
    const zip = await JSZip.loadAsync(await modifyPart('word/header1.xml', (xml) => xml.replace('</w:hdr>', '<w:customXml><w:p><w:r><w:t>Protected header</w:t></w:r></w:p></w:customXml></w:hdr>')));
    zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace(/<Override PartName="\/word\/header1\.xml"[^>]*\/>/u, ''));
    // The parser follows the header relationship even with a generic XML type.
    await assertReadOnly(await zip.generateAsync({ type: 'nodebuffer' }));
  }],
  ['refuses reproduced layout, style-override, image and field metadata losses', async () => {
    const probes: { part: string; replace: (xml: string) => string; lost: RegExp }[] = [
      { part: 'word/document.xml', replace: (xml) => xml.replace('<w:sectPr>', '<w:sectPr><w:rtlGutter w:val="1"/>'), lost: /<w:rtlGutter\b/u },
      { part: 'word/document.xml', replace: (xml) => xml.replace('<w:pgSz ', '<w:pgSz w:code="9" '), lost: /w:code="9"/u },
      { part: 'word/document.xml', replace: (xml) => xml.replace('<w:pPr>', '<w:pPr><w:bidi w:val="0"/>'), lost: /<w:bidi\b/u },
      { part: 'word/document.xml', replace: (xml) => xml.replace('<w:pPr>', '<w:pPr><w:keepNext w:val="0"/>'), lost: /<w:keepNext\b/u },
      { part: 'word/document.xml', replace: (xml) => xml.replace('<a:off x="0"', '<a:off x="12"'), lost: /<a:off x="12"/u },
      { part: 'word/document.xml', replace: (xml) => xml.replace('<a:ext cx="914400"', '<a:ext cx="800000"'), lost: /<a:ext cx="800000"/u },
      { part: 'word/document.xml', replace: (xml) => xml.replace('noChangeAspect="1"', 'noChangeAspect="0"'), lost: /noChangeAspect="0"/u },
      { part: 'word/document.xml', replace: (xml) => xml.replace('<wp:docPr ', '<wp:docPr title="Original accessible title" '), lost: /\btitle="Original accessible title"/u },
      { part: 'word/document.xml', replace: (xml) => xml.replace('<pic:cNvPr ', '<pic:cNvPr descr="Additional description" '), lost: /\bdescr="Additional description"/u },
      { part: 'word/document.xml', replace: (xml) => xml.replace('<a:blip ', '<a:blip cstate="screen" '), lost: /\bcstate="screen"/u },
      { part: 'word/footer1.xml', replace: (xml) => xml.replace('<w:fldChar ', '<w:fldChar w:fldLock="1" w:dirty="1" '), lost: /w:fldLock="1"/u },
      { part: 'word/document.xml', replace: (xml) => xml.replace('<w:body>', '<w:body><!-- protected-workflow-annotation -->'), lost: /protected-workflow-annotation/u },
    ];
    for (const probe of probes) {
      const buffer = await modifyPart(probe.part, probe.replace);
      const before = await JSZip.loadAsync(buffer);
      assert.match(await before.file(probe.part)!.async('string'), probe.lost);
      await assertReadOnly(buffer);
      // Intentionally bypass the gate only here to reproduce the library loss.
      const model = await parseDocx(buffer, { preloadFonts: false });
      const saved = await JSZip.loadAsync(await serializeDocxForEditor(model));
      assert.doesNotMatch(await saved.file(probe.part)!.async('string'), probe.lost);
    }
  }],
  ['retains paragraph/table rules with separate attribute schemas for each XML position', async () => {
    const buffer = await modifyPart('word/document.xml', (xml) => xml
      .replace('<w:pPr>', '<w:pPr><w:bidi w:val="1"/>')
      .replace('<w:tblPr>', '<w:tblPr><w:jc w:val="center"/>')
      .replace('<w:r><w:t>', '<w:r><w:rPr><w:spacing w:val="24"/></w:rPr><w:t>'));
    assert.equal((await assessDocxEditorCompatibility(buffer)).editable, true);
    const model = await parseDocx(buffer, { preloadFonts: false });
    const paragraph = model.package.document.content[0];
    assert.equal(paragraph.type, 'paragraph');
    if (paragraph.type === 'paragraph') {
      assert.equal(paragraph.formatting?.bidi, true);
      const run = paragraph.content[0];
      assert.equal(run.type, 'run');
      if (run.type === 'run') assert.equal(run.formatting?.spacing, 24);
    }
    const saved = Buffer.from(await serializeDocxForEditor(model));
    assert.equal((await assessDocxEditorCompatibility(saved)).editable, true);
    await assertReadOnly(await modifyPart('word/document.xml', (xml) => xml.replace('<w:pPr>', '<w:pPr><w:spacing w:val="24"/>')));
    await assertReadOnly(await modifyPart('word/document.xml', (xml) => xml.replace('<w:rPr>', '<w:rPr><w:spacing w:before="24"/>')));
  }],
  ['blocks strict OOXML and a main part path unsupported by the installed parser', async () => {
    const zip = await JSZip.loadAsync(await createOfficeRoundtripFixture());
    for (const entry of Object.values(zip.files)) {
      if (entry.name.endsWith('.xml') || entry.name.endsWith('.rels')) zip.file(entry.name, (await entry.async('string'))
        .replaceAll(NS.w, 'http://purl.oclc.org/ooxml/wordprocessingml/main')
        .replaceAll(NS.r, 'http://purl.oclc.org/ooxml/officeDocument/relationships'));
    }
    await assertReadOnly(await zip.generateAsync({ type: 'nodebuffer' }));
    const renamed = await JSZip.loadAsync(await createOfficeRoundtripFixture());
    renamed.file('word/alternate.xml', await renamed.file('word/document.xml')!.async('nodebuffer'));
    renamed.remove('word/document.xml');
    renamed.file('word/_rels/alternate.xml.rels', await renamed.file('word/_rels/document.xml.rels')!.async('nodebuffer'));
    renamed.remove('word/_rels/document.xml.rels');
    for (const part of ['[Content_Types].xml', '_rels/.rels']) renamed.file(part, (await renamed.file(part)!.async('string')).replaceAll('word/document.xml', 'word/alternate.xml'));
    await assertReadOnly(await renamed.generateAsync({ type: 'nodebuffer' }));
    const nonCanonical = await JSZip.loadAsync(await createOfficeRoundtripFixture());
    nonCanonical.file('[content_types].xml', await nonCanonical.file('[Content_Types].xml')!.async('nodebuffer'));
    nonCanonical.remove('[Content_Types].xml');
    await assertReadOnly(await nonCanonical.generateAsync({ type: 'nodebuffer' }));
  }],
  ['enforces ZIP/XML size validation before JSZip parsing for compatibility inspection', async () => {
    const load = JSZip.loadAsync;
    let called = false;
    JSZip.loadAsync = async () => { called = true; throw new Error('JSZip must not run before validation.'); };
    try {
      await assert.rejects(() => assessDocxEditorCompatibility(Buffer.alloc(DOCX_PACKAGE_LIMITS.compressedBytes + 1)), (error: unknown) => error instanceof DocxPackageValidationError && error.code === 'DOCX_PACKAGE_TOO_LARGE');
      assert.equal(called, false);
    } finally {
      JSZip.loadAsync = load;
    }
  }],
  ['keeps a pre-existing main/header image relationship and avoids image growth over repeated reopen/save cycles', async () => {
    const zip = await JSZip.loadAsync(await createOfficeRoundtripFixture());
    const documentXml = await zip.file('word/document.xml')!.async('string');
    const drawing = documentXml.slice(documentXml.indexOf('<w:drawing>'), documentXml.indexOf('</w:drawing>') + '</w:drawing>'.length);
    const namespaces = `xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"`;
    zip.file('word/header1.xml', (await zip.file('word/header1.xml')!.async('string')).replace('<w:hdr ', `<w:hdr ${namespaces} `).replace('</w:hdr>', `<w:p><w:r>${drawing}</w:r></w:p></w:hdr>`));
    zip.file('word/_rels/header1.xml.rels', `<Relationships xmlns="${NS.rels}"><Relationship Id="rImage" Type="${NS.r}/image" Target="media/pixel.png"/></Relationships>`);
    let buffer = await zip.generateAsync({ type: 'nodebuffer' });
    for (let cycle = 0; cycle < 4; cycle++) {
      assert.equal((await assessDocxEditorCompatibility(buffer)).editable, true);
      const model = await parseDocx(buffer, { preloadFonts: false });
      const before = structuredClone(model);
      buffer = Buffer.from(await serializeDocxForEditor(model));
      assert.deepEqual(model, before);
      await validateDocxPackage(buffer);
      const saved = await JSZip.loadAsync(buffer);
      assert.equal(Object.values(saved.files).filter((entry) => entry.name.startsWith('word/media/') && !entry.dir).length, 1);
      assert.match(await saved.file('word/document.xml')!.async('string'), /r:embed="rImage"/u);
      assert.match(await saved.file('word/header1.xml')!.async('string'), /r:embed="rImage"/u);
      assert.deepEqual(await saved.file('word/media/pixel.png')!.async('nodebuffer'), OFFICE_ROUNDTRIP_PNG);
    }
  }],
  ['saves newly inserted and genuinely replaced image bytes and remains editable on reopen', async () => {
    for (const insertion of [false, true]) {
      const model = await parseDocx(await createOfficeRoundtripFixture(), { preloadFonts: false });
      const existing = drawingImages(model.package.document.content)[0];
      const newBytes = bluePixelPng();
      const image = insertion ? structuredClone(existing) : existing;
      image.src = `data:image/png;base64,${newBytes.toString('base64')}`;
      if (insertion) {
        image.rId = 'new-client-image';
        model.package.document.content.push({ type: 'paragraph', content: [{ type: 'run', content: [{ type: 'drawing', image }] }] });
      }
      let buffer = Buffer.from(await serializeDocxForEditor(model));
      for (let cycle = 0; cycle < 3; cycle++) {
        await validateDocxPackage(buffer);
        assert.equal((await assessDocxEditorCompatibility(buffer)).editable, true);
        const saved = await JSZip.loadAsync(buffer);
        const media = Object.values(saved.files).filter((entry) => entry.name.startsWith('word/media/') && !entry.dir);
        assert.equal(media.length, 2);
        assert.ok((await Promise.all(media.map((entry) => entry.async('nodebuffer')))).some((bytes) => bytes.equals(newBytes)));
        const reopened = await parseDocx(buffer, { preloadFonts: false });
        const images = drawingImages(reopened.package.document.content);
        assert.equal(images.length, insertion ? 2 : 1);
        assert.ok(images.some((drawing) => drawing.src === `data:image/png;base64,${newBytes.toString('base64')}`));
        buffer = Buffer.from(await serializeDocxForEditor(reopened));
      }
    }
  }],
];

async function main(): Promise<void> {
  for (const [name, run] of tests) {
    await run();
    process.stdout.write(`✓ ${name}\n`);
  }
  process.stdout.write(`Office editor compatibility: ${tests.length} scenarios passed.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
