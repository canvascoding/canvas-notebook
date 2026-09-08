import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { DOCX_PACKAGE_LIMITS, DocxPackageValidationError, validateDocxPackage, type DocxPackageErrorCode } from '../app/lib/office/docx-package';

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const STRICT_WORD = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const OFFICE_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STRICT_OFFICE_RELS = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=', 'base64');
const OPAQUE_PART = Buffer.from([0, 1, 255, 80, 75, 3, 4, 8, 9, 0, 222]);

function fixture(options: { strict?: boolean; folder?: string } = {}): JSZip {
  const zip = new JSZip();
  const folder = options.folder ?? 'word';
  const word = options.strict ? STRICT_WORD : WORD;
  const rels = options.strict ? STRICT_OFFICE_RELS : OFFICE_RELS;
  zip.file('[Content_Types].xml', `${XML}<Types xmlns="${CONTENT_TYPES}">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Default Extension="png" ContentType="image/png"/>
    <Default Extension="bin" ContentType="application/octet-stream"/>
    <Override PartName="/${folder}/document.xml" ContentType="${MAIN_TYPE}"/>
    <Override PartName="/${folder}/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
    <Override PartName="/${folder}/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
  </Types>`);
  zip.file('_rels/.rels', `${XML}<Relationships xmlns="${PACKAGE_RELS}">
    <Relationship Id="rMain" Type="${rels}/officeDocument" Target="${folder}/document.xml"/>
  </Relationships>`);
  zip.file(`${folder}/document.xml`, `${XML}<w:document xmlns:w="${word}" xmlns:r="${rels}"
    xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
    xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
    xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
    <w:body>
      <w:p><w:r><w:t xml:space="preserve">Quarterly report – café &amp; team</w:t></w:r></w:p>
      <w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
      <w:p><w:del w:id="1" w:author="Editor" w:date="2026-09-08T10:00:00Z"><w:r><w:delText>old</w:delText></w:r></w:del>
        <w:ins w:id="2" w:author="Editor" w:date="2026-09-08T10:00:00Z"><w:r><w:t>new</w:t></w:r></w:ins>
        <w:commentRangeStart w:id="0"/><w:r><w:t>Review this</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>
      </w:p>
      <w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Pixel"/>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
          <pic:nvPicPr><pic:cNvPr id="1" name="pixel.png"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="rImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
      <w:p><w:hyperlink r:id="rExternal"><w:r><w:t>External reference</w:t></w:r></w:hyperlink></w:p>
      <w:sectPr><w:headerReference w:type="default" r:id="rHeader"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
    </w:body>
  </w:document>`);
  zip.file(`${folder}/_rels/document.xml.rels`, `${XML}<Relationships xmlns="${PACKAGE_RELS}">
    <Relationship Id="rImage" Type="${rels}/image" Target="media/pixel.png"/>
    <Relationship Id="rHeader" Type="${rels}/header" Target="header1.xml"/>
    <Relationship Id="rComments" Type="${rels}/comments" Target="comments.xml"/>
    <Relationship Id="rMetadata" Type="${rels}/customXml" Target="../customXml/item1.xml"/>
    <Relationship Id="rExternal" Type="${rels}/hyperlink" Target="https://example.invalid/document?q=1#section" TargetMode="External"/>
  </Relationships>`);
  zip.file(`${folder}/header1.xml`, `${XML}<w:hdr xmlns:w="${word}"><w:p><w:r><w:t>Confidential report</w:t></w:r></w:p></w:hdr>`);
  zip.file(`${folder}/comments.xml`, `${XML}<w:comments xmlns:w="${word}"><w:comment w:id="0" w:author="Reviewer"><w:p><w:r><w:t>Keep this comment.</w:t></w:r></w:p></w:comment></w:comments>`);
  zip.file(`${folder}/media/pixel.png`, PIXEL_PNG);
  zip.file(`${folder}/vendor/opaque.bin`, OPAQUE_PART);
  zip.file('customXml/item1.xml', `${XML}<vendor:metadata xmlns:vendor="urn:canvas:test:unknown"><vendor:unknown flag="keep">Opaque extension</vendor:unknown></vendor:metadata>`);
  return zip;
}

async function generate(zip = fixture(), options: { compression?: 'STORE' | 'DEFLATE'; streamFiles?: boolean } = {}): Promise<Buffer> {
  return zip.generateAsync({ type: 'nodebuffer', compression: options.compression ?? 'DEFLATE', streamFiles: options.streamFiles ?? false });
}

async function replaceXml(zip: JSZip, name: string, replace: (xml: string) => string): Promise<JSZip> {
  zip.file(name, replace(await zip.file(name)!.async('string')));
  return zip;
}

async function rejects(buffer: Buffer, code: DocxPackageErrorCode = 'DOCX_INVALID_PACKAGE'): Promise<void> {
  await assert.rejects(() => validateDocxPackage(buffer), (error: unknown) => {
    assert.ok(error instanceof DocxPackageValidationError);
    assert.equal(error.code, code);
    assert.equal(error.status, code === 'DOCX_PACKAGE_TOO_LARGE' ? 413 : 422);
    return true;
  });
}

type RawEntry = { name: string | Buffer; data?: Buffer; size?: number; method?: number; flags?: number; extra?: Buffer; externalAttributes?: number };

/** Hand-built ZIPs let tests exercise cases JSZip repairs/overwrites on load. */
function rawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
    const data = entry.data ?? Buffer.from('x');
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const extra = entry.extra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.size ?? data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    local.copy(central, 6, 4, 26);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    locals.push(local, name, extra, compressed);
    centrals.push(central, name, extra);
    localOffset += local.length + name.length + extra.length + compressed.length;
  }
  const centralData = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralData, end]);
}

function headers(buffer: Buffer): { name: string; central: number; local: number; data: number; size: number }[] {
  const end = buffer.length - 22;
  let central = buffer.readUInt32LE(end + 16);
  const entries = [];
  while (central < end) {
    const nameSize = buffer.readUInt16LE(central + 28);
    const local = buffer.readUInt32LE(central + 42);
    entries.push({
      name: buffer.subarray(central + 46, central + 46 + nameSize).toString('utf8'),
      central, local,
      data: local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28),
      size: buffer.readUInt32LE(central + 20),
    });
    central += 46 + nameSize + buffer.readUInt16LE(central + 30) + buffer.readUInt16LE(central + 32);
  }
  return entries;
}

const tests: [string, () => Promise<void>][] = [
  ['preserves every byte in DOCX tables, images, headers, comments, tracked changes and unknown extensions', async () => {
    const buffer = await generate();
    const before = Buffer.from(buffer);
    const digest = createHash('sha256').update(buffer).digest('hex');
    const summary = await validateDocxPackage(buffer);
    assert.equal(summary.mainDocumentPart, 'word/document.xml');
    assert.equal(summary.conformance, 'transitional');
    assert.equal(summary.compressedBytes, buffer.length);
    assert.equal(summary.partCount, 9);
    assert.equal(summary.xmlPartCount, 7);
    assert.equal(summary.entryCount, headers(buffer).length);
    assert.equal(summary.uncompressedBytes, headers(buffer).reduce((sum, entry) => sum + buffer.readUInt32LE(entry.central + 24), 0));
    assert.deepEqual(buffer, before);
    assert.equal(createHash('sha256').update(buffer).digest('hex'), digest);
    const loaded = await JSZip.loadAsync(buffer);
    assert.deepEqual(await loaded.file('word/media/pixel.png')!.async('nodebuffer'), PIXEL_PNG);
    assert.deepEqual(await loaded.file('word/vendor/opaque.bin')!.async('nodebuffer'), OPAQUE_PART);
    assert.match(await loaded.file('word/document.xml')!.async('string'), /<w:tbl>[\s\S]*<w:del /u);
  }],
  ['accepts strict OOXML and the main document at a non-default part path', async () => {
    const summary = await validateDocxPackage(await generate(fixture({ strict: true, folder: 'documents' })));
    assert.equal(summary.conformance, 'strict');
    assert.equal(summary.mainDocumentPart, 'documents/document.xml');
    const encoded = await validateDocxPackage(await generate(fixture({ folder: 'part%25names' })));
    assert.equal(encoded.mainDocumentPart, 'part%25names/document.xml');
  }],
  ['accepts stored entries and streaming ZIP data descriptors', async () => {
    for (const compression of ['STORE', 'DEFLATE'] as const) {
      for (const streamFiles of [false, true]) await validateDocxPackage(await generate(fixture(), { compression, streamFiles }));
    }
  }],
  ['accepts UTF-16 XML and preserves Unicode part names', async () => {
    for (const bigEndian of [false, true]) {
      const zip = fixture();
      const xml = (await zip.file('word/document.xml')!.async('string')).replace('encoding="UTF-8"', 'encoding="UTF-16"');
      const bytes = Buffer.from(`\ufeff${xml}`, 'utf16le');
      zip.file('word/document.xml', bigEndian ? bytes.swap16() : bytes);
      zip.file('word/vendor/überraschung.bin', OPAQUE_PART);
      await validateDocxPackage(await generate(zip));
    }
  }],
  ['rejects empty, non-ZIP and truncated inputs with typed errors', async () => {
    await rejects(Buffer.alloc(0));
    await rejects(Buffer.from('This is a markdown document rather than a Word ZIP package.'));
    await rejects((await generate()).subarray(0, -5));
    await rejects(rawZip([]));
  }],
  ['rejects compressed, per-entry, total expanded, entry-count and name limits before inflation', async () => {
    await rejects(Buffer.alloc(DOCX_PACKAGE_LIMITS.compressedBytes + 1), 'DOCX_PACKAGE_TOO_LARGE');
    await rejects(rawZip([{ name: 'large.bin', size: DOCX_PACKAGE_LIMITS.entryBytes + 1 }]), 'DOCX_PACKAGE_TOO_LARGE');
    await rejects(rawZip([1, 2, 3].map((index) => ({ name: `${index}.bin`, size: 44 * 1024 * 1024 }))), 'DOCX_PACKAGE_TOO_LARGE');
    await rejects(rawZip(Array.from({ length: DOCX_PACKAGE_LIMITS.entries + 1 }, (_, index) => ({ name: `${index}.bin` }))), 'DOCX_PACKAGE_TOO_LARGE');
    await rejects(rawZip([{ name: 'a'.repeat(DOCX_PACKAGE_LIMITS.entryNameBytes + 1) }]), 'DOCX_PACKAGE_TOO_LARGE');
  }],
  ['rejects traversal, encoded traversal, absolute paths, unsafe separators and duplicate/case-equivalent paths', async () => {
    for (const name of ['../outside.xml', 'word/../../outside.xml', 'word/%2e%2e/outside.xml', '/outside.xml', 'C:/outside.xml', 'word\\outside.xml', 'word/%2foutside.xml', 'word//outside.xml', 'word/file\0.xml', 'word/invalid%.xml']) {
      await rejects(rawZip([{ name }]));
    }
    for (const alias of ['word/document.xml', 'WORD/document.xml', 'word/%64ocument.xml']) {
      await rejects(rawZip([{ name: 'word/document.xml' }, { name: alias }]));
    }
  }],
  ['rejects encrypted, unsupported compression, ZIP64, split and symbolic-link packages', async () => {
    await rejects(rawZip([{ name: 'x', flags: 1 }]), 'DOCX_UNSUPPORTED_PACKAGE');
    await rejects(rawZip([{ name: 'x', method: 12 }]), 'DOCX_UNSUPPORTED_PACKAGE');
    await rejects(rawZip([{ name: 'x', extra: Buffer.from([1, 0, 0, 0]) }]), 'DOCX_UNSUPPORTED_PACKAGE');
    await rejects(rawZip([{ name: 'x', externalAttributes: 0xa1ff0000 }]), 'DOCX_UNSUPPORTED_PACKAGE');
    await rejects(rawZip([{ name: Buffer.from([0xe9]), flags: 0 }]), 'DOCX_UNSUPPORTED_PACKAGE');
    const split = await generate();
    split.writeUInt16LE(1, split.length - 22 + 4);
    await rejects(split, 'DOCX_UNSUPPORTED_PACKAGE');
  }],
  ['rejects central/local size, filename, flags and data-descriptor disagreements', async () => {
    for (const mutate of [
      (buffer: Buffer, header: ReturnType<typeof headers>[number]) => buffer.writeUInt32LE(1, header.local + 22),
      (buffer: Buffer, header: ReturnType<typeof headers>[number]) => buffer.writeUInt16LE(0x0800, header.local + 6),
      (buffer: Buffer, header: ReturnType<typeof headers>[number]) => { buffer[header.local + 30] ^= 1; },
    ]) {
      const buffer = await generate();
      mutate(buffer, headers(buffer).find((entry) => entry.name === 'word/document.xml')!);
      await rejects(buffer);
    }
    const streamed = await generate(fixture(), { streamFiles: true });
    const streamedEntry = headers(streamed).find((entry) => entry.name === 'word/document.xml')!;
    streamed.writeUInt32LE(1, streamedEntry.data + streamedEntry.size + 8);
    await rejects(streamed);
  }],
  ['rejects corrupt bytes/checksums and overlapping or unlisted ZIP data', async () => {
    for (const compression of ['STORE', 'DEFLATE'] as const) {
      const buffer = await generate(fixture(), { compression });
      const header = headers(buffer).find((entry) => entry.name === 'word/vendor/opaque.bin')!;
      buffer[header.data] ^= 255;
      await rejects(buffer);
    }
    const original = await generate();
    const directoryOffset = original.readUInt32LE(original.length - 6);
    const hidden = Buffer.concat([original.subarray(0, directoryOffset), Buffer.from([0]), original.subarray(directoryOffset)]);
    hidden.writeUInt32LE(directoryOffset + 1, hidden.length - 6);
    await rejects(hidden);
    const overlapping = await generate();
    const rows = headers(overlapping);
    overlapping.writeUInt32LE(rows[0].local, rows[1].central + 42);
    await rejects(overlapping);
  }],
  ['hard-bounds inflation when both size fields lie about a compressed bomb', async () => {
    const zip = fixture();
    zip.file('word/vendor/bomb.bin', Buffer.alloc(8 * 1024 * 1024, 65));
    const buffer = await generate(zip);
    const header = headers(buffer).find((entry) => entry.name === 'word/vendor/bomb.bin')!;
    buffer.writeUInt32LE(1, header.local + 22);
    buffer.writeUInt32LE(1, header.central + 24);
    await rejects(buffer);
  }],
  ['rejects malformed XML, XML entities/DOCTYPE, wrong encoding, duplicate attributes and unbound prefixes', async () => {
    for (const xml of [
      `<w:document xmlns:w="${WORD}"><w:body></w:document>`,
      `<!DOCTYPE w:document [<!ENTITY external SYSTEM "file:///etc/passwd">]><w:document xmlns:w="${WORD}"><w:body>&external;</w:body></w:document>`,
      `<w:document xmlns:w="${WORD}"><w:body>&notDefined;</w:body></w:document>`,
      `<w:document xmlns:w="${WORD}" duplicate="1" duplicate="2"><w:body/></w:document>`,
      `<w:document xmlns:w="${WORD}"><w:body><unknown:p/></w:body></w:document>`,
      `<?xml version="1.0" encoding="UTF-16"?><w:document xmlns:w="${WORD}"><w:body/></w:document>`,
    ]) {
      const zip = fixture().file('word/document.xml', xml);
      await rejects(await generate(zip));
    }
    await rejects(await generate(fixture().file('word/document.xml', Buffer.from([0xff, 0xff, 0x3c, 0x3e]))));
    await rejects(await generate(fixture().file('customXml/item1.xml', '<broken>')));
  }],
  ['rejects excessive XML depth and XML part size', async () => {
    const deep = `<w:document xmlns:w="${WORD}"><w:body>${'<w:p>'.repeat(DOCX_PACKAGE_LIMITS.xmlDepth)}${'</w:p>'.repeat(DOCX_PACKAGE_LIMITS.xmlDepth)}</w:body></w:document>`;
    await rejects(await generate(fixture().file('word/document.xml', deep)), 'DOCX_PACKAGE_TOO_LARGE');
    const large = fixture().file('customXml/item1.xml', ' '.repeat(DOCX_PACKAGE_LIMITS.xmlPartBytes + 1));
    await rejects(await generate(large), 'DOCX_PACKAGE_TOO_LARGE');
  }],
  ['rejects missing manifest, main relationship, main document and invalid body/root', async () => {
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
      await rejects(await generate(fixture().remove(part)));
    }
    for (const xml of [
      `<other xmlns="${WORD}"><body/></other>`,
      '<document xmlns="urn:wrong"><body/></document>',
      `<w:document xmlns:w="${WORD}"/>`,
      `<w:document xmlns:w="${WORD}"><w:body/><w:body/></w:document>`,
    ]) await rejects(await generate(fixture().file('word/document.xml', xml)));
  }],
  ['rejects malformed content type manifests and unsupported main document types', async () => {
    const cases = [
      (xml: string) => xml.replace(CONTENT_TYPES, 'urn:wrong'),
      (xml: string) => xml.replace('</Types>', 'Unexpected text</Types>'),
      (xml: string) => xml.replace(MAIN_TYPE, 'application/vnd.ms-word.document.macroEnabled.main+xml'),
      (xml: string) => xml.replace('</Types>', `<Default Extension="XML" ContentType="application/xml"/></Types>`),
      (xml: string) => xml.replace('</Types>', `<Override PartName="/word/missing.xml" ContentType="application/xml"/></Types>`),
      (xml: string) => xml.replace(/<Default Extension="bin"[^>]*\/>/u, ''),
    ];
    for (const replace of cases) await rejects(await generate(await replaceXml(fixture(), '[Content_Types].xml', replace)));
  }],
  ['rejects duplicate, malformed, missing, escaping or external main relationships', async () => {
    for (const replace of [
      (xml: string) => xml.replace('Target="word/document.xml"', 'Target="https://example.invalid/document.xml" TargetMode="External"'),
      (xml: string) => xml.replace('Target="word/document.xml"', 'Target="../word/document.xml"'),
      (xml: string) => xml.replace('Target="word/document.xml"', 'Target="word/missing.xml"'),
      (xml: string) => xml.replace(PACKAGE_RELS, 'urn:wrong'),
      (xml: string) => xml.replace('</Relationships>', '<![CDATA[Unexpected text]]></Relationships>'),
      (xml: string) => xml.replace('</Relationships>', `<Relationship Id="rOther" Type="${OFFICE_RELS}/officeDocument" Target="word/document.xml"/></Relationships>`),
      (xml: string) => xml.replace('</Relationships>', `<Relationship Id="rMain" Type="${OFFICE_RELS}/customXml" Target="customXml/item1.xml"/></Relationships>`),
      (xml: string) => xml.replace('Id="rMain"', 'Id=""'),
    ]) await rejects(await generate(await replaceXml(fixture(), '_rels/.rels', replace)));
    for (const target of ['media/missing.png', '../../outside.png', '//server/image.png', 'media/%2fimage.png']) {
      await rejects(await generate(await replaceXml(fixture(), 'word/_rels/document.xml.rels', (xml) => xml.replace('media/pixel.png', target))));
    }
  }],
  ['rejects dangling document references and invalid relationship sources', async () => {
    await rejects(await generate(await replaceXml(fixture(), 'word/document.xml', (xml) => xml.replace('r:embed="rImage"', 'r:embed="rMissing"'))));
    const zip = fixture();
    zip.file('word/_rels/missing.xml.rels', `${XML}<Relationships xmlns="${PACKAGE_RELS}"/>`);
    await rejects(await generate(zip));
  }],
];

async function main(): Promise<void> {
  for (const [name, run] of tests) {
    await run();
    process.stdout.write(`✓ ${name}\n`);
  }
  process.stdout.write(`DOCX package validation: ${tests.length} scenarios passed.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
