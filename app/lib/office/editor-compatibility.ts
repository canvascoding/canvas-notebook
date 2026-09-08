import 'server-only';

import JSZip from 'jszip';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { validateDocxPackage } from './docx-package';

export type DocxEditorCompatibility = { editable: boolean; reasons: string[] };

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  w16cid: 'http://schemas.microsoft.com/office/word/2016/wordml/cid',
  w16cex: 'http://schemas.microsoft.com/office/word/2018/wordml/cex',
  xml: 'http://www.w3.org/XML/1998/namespace',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
};
const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REWRITTEN_RELATIONSHIPS = new Set(['header', 'footer', 'comments', 'commentsExtended', 'commentsIds', 'commentsExtensible']);
const REWRITTEN_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml',
]);

type Rule = { attributes: Set<string>; parents: Set<string>; accepts?: (tag: SaxesTagNS) => boolean };
const rules = new Map<string, Rule[]>();

function qualified(name: string): string {
  if (name.startsWith('@')) return `|${name.slice(1)}`;
  const [prefix, local] = name.split(':');
  return `${NS[prefix as keyof typeof NS]}|${local}`;
}

function allow(names: string, attributes: string, parents: string, accepts?: Rule['accepts']): void {
  for (const name of names.split(' ')) {
    const key = qualified(name);
    const variants = rules.get(key) ?? [];
    variants.push({
      attributes: new Set(attributes.split(' ').filter(Boolean).map(qualified)),
      parents: new Set(parents.split(' ').filter(Boolean).map(qualified)), accepts,
    });
    rules.set(key, variants);
  }
}

function enabledToggle(tag: SaxesTagNS): boolean {
  const value = Object.values(tag.attributes).find((attr) => attr.uri === NS.w && attr.local === 'val')?.value;
  return value === undefined || ['1', 'true', 'on'].includes(value);
}

// Deliberately smaller than all of OOXML. These are constructs represented by
// the installed editor model/serializer, with acceptance coverage below. Unknown
// elements, attributes AND positions are read-only, including mc:Ignorable data.
allow('w:document w:hdr w:ftr w:comments', '', '');
allow('w:body', '', 'w:document');
allow('w:p', 'w14:paraId w14:textId w:rsidR w:rsidRDefault w:rsidP w:rsidRPr w:rsidDel', 'w:body w:tc w:hdr w:ftr w:comment');
allow('w:pPr', '', 'w:p');
allow('w:r', 'w:rsidR w:rsidRPr w:rsidDel', 'w:p w:hyperlink w:ins w:del w:fldSimple');
allow('w:rPr', '', 'w:r w:pPr');
allow('w:t w:delText w:instrText', 'xml:space', 'w:r');
allow('w:tab w:softHyphen w:noBreakHyphen', '', 'w:r');
allow('w:br', 'w:type w:clear', 'w:r');
allow('w:hyperlink', 'r:id w:anchor w:tooltip w:tgtFrame w:docLocation', 'w:p');
allow('w:bookmarkStart', 'w:id w:name', 'w:p');
allow('w:bookmarkEnd', 'w:id', 'w:p');
allow('w:commentRangeStart w:commentRangeEnd', 'w:id', 'w:p');
allow('w:commentReference', 'w:id', 'w:r');
allow('w:annotationRef', '', 'w:r');
allow('w:comment', 'w:id w:author w:initials w:date', 'w:comments');
allow('w:ins w:del', 'w:id w:author w:date', 'w:p');
allow('w:fldChar', 'w:fldCharType', 'w:r');
allow('w:fldSimple', 'w:instr', 'w:p');
allow('w:pStyle w:jc w:widowControl w:outlineLvl', 'w:val', 'w:pPr');
// The serializer omits explicit false for these properties. That can change a
// style override, so only its lossless enabled representation is eligible.
allow('w:bidi w:keepNext w:keepLines w:pageBreakBefore w:contextualSpacing w:suppressLineNumbers w:suppressAutoHyphens', 'w:val', 'w:pPr', enabledToggle);
allow('w:ind', 'w:left w:right w:firstLine w:hanging', 'w:pPr');
allow('w:spacing', 'w:before w:after w:line w:lineRule w:beforeAutospacing w:afterAutospacing', 'w:pPr');
allow('w:spacing', 'w:val', 'w:rPr');
allow('w:tabs w:numPr w:pBdr', '', 'w:pPr');
allow('w:tab', 'w:val w:leader w:pos', 'w:tabs w:r');
allow('w:numId w:ilvl', 'w:val', 'w:numPr');
allow('w:b w:bCs w:i w:iCs w:strike w:dstrike w:vertAlign w:smallCaps w:caps w:vanish w:sz w:szCs w:kern w:position w:w w:effect w:em w:emboss w:imprint w:outline w:shadow w:rtl w:cs w:rStyle w:highlight', 'w:val', 'w:rPr');
allow('w:u', 'w:val w:color w:themeColor w:themeTint w:themeShade', 'w:rPr');
allow('w:color', 'w:val w:themeColor w:themeTint w:themeShade', 'w:rPr');
allow('w:rFonts', 'w:ascii w:hAnsi w:eastAsia w:cs w:asciiTheme w:hAnsiTheme w:eastAsiaTheme w:csTheme', 'w:rPr');
allow('w:shd', 'w:val w:color w:fill w:themeColor w:themeFill w:themeTint w:themeShade w:themeFillTint w:themeFillShade', 'w:rPr w:pPr w:tcPr w:tblPr');
allow('w:tbl', '', 'w:body w:tc w:hdr w:ftr w:comment');
allow('w:tblPr w:tblGrid', '', 'w:tbl');
allow('w:tblStyle', 'w:val', 'w:tblPr');
allow('w:tblLayout', 'w:type', 'w:tblPr');
allow('w:tblLook', 'w:val w:firstRow w:lastRow w:firstColumn w:lastColumn w:noHBand w:noVBand', 'w:tblPr');
allow('w:tblW w:tblInd w:tblCellSpacing', 'w:w w:type', 'w:tblPr');
allow('w:jc', 'w:val', 'w:tblPr');
allow('w:tblBorders w:tblCellMar', '', 'w:tblPr');
allow('w:gridCol', 'w:w', 'w:tblGrid');
allow('w:tr', 'w:rsidR w:rsidRPr w:rsidDel w:rsidTr', 'w:tbl');
allow('w:trPr', '', 'w:tr');
allow('w:tblHeader w:cantSplit', 'w:val', 'w:trPr', enabledToggle);
allow('w:trHeight', 'w:val w:hRule', 'w:trPr');
allow('w:tc', '', 'w:tr');
allow('w:tcPr', '', 'w:tc');
allow('w:tcW', 'w:w w:type', 'w:tcPr');
allow('w:gridSpan w:vMerge w:vAlign w:textDirection', 'w:val', 'w:tcPr');
allow('w:noWrap w:tcFitText', 'w:val', 'w:tcPr', enabledToggle);
allow('w:tcBorders w:tcMar', '', 'w:tcPr');
allow('w:top w:bottom w:left w:right w:insideH w:insideV', 'w:val w:sz w:space w:color w:themeColor w:themeTint w:themeShade w:shadow w:frame', 'w:tblBorders w:tcBorders');
allow('w:top w:bottom w:left w:right w:between w:bar', 'w:val w:sz w:space w:color w:themeColor w:themeTint w:themeShade w:shadow w:frame', 'w:pBdr');
allow('w:top w:bottom w:left w:right', 'w:w w:type', 'w:tblCellMar w:tcMar');
allow('w:sectPr', 'w:rsidR w:rsidRPr w:rsidSect', 'w:body w:pPr');
allow('w:headerReference w:footerReference', 'w:type r:id', 'w:sectPr');
allow('w:pgSz', 'w:w w:h w:orient', 'w:sectPr');
allow('w:pgMar', 'w:top w:right w:bottom w:left w:header w:footer w:gutter', 'w:sectPr');
allow('w:type', 'w:val', 'w:sectPr');
allow('w:titlePg w:bidi', 'w:val', 'w:sectPr', enabledToggle);
allow('w:cols', 'w:space w:num w:equalWidth w:sep', 'w:sectPr');
allow('w:col', 'w:w w:space', 'w:cols');
allow('w:pgNumType', 'w:fmt w:start', 'w:sectPr');
allow('w:docGrid', 'w:type w:linePitch w:charSpace', 'w:sectPr');
allow('w:drawing', '', 'w:r');
allow('wp:inline', '@distT @distB @distL @distR', 'w:drawing');
allow('wp:extent', '@cx @cy', 'wp:inline');
allow('wp:effectExtent', '@l @t @r @b', 'wp:inline', (tag) => Object.values(tag.attributes).every((attr) => attr.uri || Number(attr.value) === 0));
allow('wp:docPr', '@id @name @descr', 'wp:inline');
allow('wp:cNvGraphicFramePr', '', 'wp:inline');
allow('a:graphicFrameLocks', '@noChangeAspect', 'wp:cNvGraphicFramePr', (tag) => ['1', 'true'].includes(tag.attributes.noChangeAspect?.value ?? '1'));
allow('a:graphic', '', 'wp:inline');
allow('a:graphicData', '@uri', 'a:graphic', (tag) => tag.attributes.uri?.value === NS.pic);
allow('pic:pic', '', 'a:graphicData');
allow('pic:nvPicPr pic:blipFill pic:spPr', '', 'pic:pic');
allow('pic:cNvPr', '@id @name @descr', 'pic:nvPicPr');
allow('pic:cNvPicPr', '', 'pic:nvPicPr');
allow('a:blip', 'r:embed', 'pic:blipFill');
allow('a:alphaModFix', '@amt', 'a:blip');
allow('a:srcRect', '@l @t @r @b', 'pic:blipFill');
allow('a:stretch', '', 'pic:blipFill');
allow('a:fillRect', '', 'a:stretch');
allow('a:xfrm', '@rot @flipH @flipV', 'pic:spPr');
allow('a:off', '@x @y', 'a:xfrm', (tag) => Object.values(tag.attributes).every((attr) => attr.uri || Number(attr.value) === 0));
allow('a:ext', '@cx @cy', 'a:xfrm');
allow('a:prstGeom', '@prst', 'pic:spPr', (tag) => tag.attributes.prst?.value === 'rect');
allow('a:avLst', '', 'a:prstGeom');
allow('w15:commentsEx w16cid:commentsIds w16cex:commentsExtensible', '', '');
allow('w15:commentEx', 'w15:paraId w15:paraIdParent w15:done', 'w15:commentsEx');
allow('w16cid:commentId', 'w16cid:paraId w16cid:durableId', 'w16cid:commentsIds');
allow('w16cex:commentExtensible', 'w16cex:durableId w16cex:dateUtc w16cex:intelligentPlaceholder', 'w16cex:commentsExtensible');

function decodeXml(bytes: Uint8Array): string {
  const encoding = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0) ? 'utf-16le'
    : (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c) ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

function inspectPart(xml: string, reasons: Set<string>): void {
  const parser = new SaxesParser({ xmlns: true });
  const ancestors: string[] = [];
  const inlineExtents: { cx?: string; cy?: string; description?: string }[] = [];
  parser.on('opentag', (tag) => {
    const key = `${tag.uri}|${tag.local}`;
    const parent = ancestors[ancestors.length - 1];
    if (key === qualified('wp:inline')) inlineExtents.push({});
    if (key === qualified('wp:extent') && inlineExtents.length > 0) {
      inlineExtents[inlineExtents.length - 1] = { cx: tag.attributes.cx?.value, cy: tag.attributes.cy?.value };
    }
    if (key === qualified('wp:docPr') && inlineExtents.length > 0) inlineExtents[inlineExtents.length - 1].description = tag.attributes.descr?.value;
    if (key === qualified('pic:cNvPr') && tag.attributes.descr?.value !== undefined && tag.attributes.descr.value !== inlineExtents[inlineExtents.length - 1]?.description) {
      reasons.add('The document contains additional image metadata that the browser editor cannot safely preserve.');
    }
    if (key === qualified('a:ext')) {
      const extent = inlineExtents[inlineExtents.length - 1];
      if (!extent || Number(extent.cx) !== Number(tag.attributes.cx?.value) || Number(extent.cy) !== Number(tag.attributes.cy?.value)) {
        reasons.add('The document contains image geometry that the browser editor cannot safely preserve.');
      }
    }
    // Keep separate attribute schemas per position (e.g. w:spacing in pPr/rPr).
    const rule = rules.get(key)?.find((variant) => parent ? variant.parents.has(parent) : variant.parents.size === 0);
    if (!rule || (rule.accepts && !rule.accepts(tag))) {
      reasons.add(tag.uri === NS.w && tag.local === 'customXml'
        ? 'Custom XML regions require an editor that preserves their embedded content.'
        : 'The document contains features or extension content that the browser editor cannot safely preserve.');
    } else {
      for (const attr of Object.values(tag.attributes)) {
        // Namespace declarations and ignorable-prefix lists are serialization metadata.
        if (attr.uri === 'http://www.w3.org/2000/xmlns/' || (attr.uri === NS.mc && attr.local === 'Ignorable')) continue;
        if (!rule.attributes.has(`${attr.uri}|${attr.local}`)) reasons.add('The document contains formatting or metadata that is not supported for safe browser editing.');
      }
    }
    ancestors.push(key);
  });
  parser.on('closetag', () => {
    if (ancestors.pop() === qualified('wp:inline')) inlineExtents.pop();
  });
  parser.on('processinginstruction', () => reasons.add('The document contains processing instructions that the browser editor cannot preserve.'));
  parser.on('comment', () => reasons.add('The document contains embedded XML annotations that the browser editor cannot preserve.'));
  parser.write(xml).close();
}

/**
 * Browser-editing eligibility, not general DOCX validity or an agent-write gate.
 * Revalidate before JSZip inflation. The caller must use the same immutable bytes
 * for this assessment and the editor download. Separate opaque parts are retained
 * by repackDocx; only parts the installed serializer can rewrite are allowlisted.
 * This is a conservative, tested subset for editor 0.5.3, not full OOXML schema
 * validation or a guarantee of fidelity for every combination of Word features.
 * Extend eligibility only with a real parser/serializer roundtrip regression.
 */
export async function assessDocxEditorCompatibility(buffer: Buffer): Promise<DocxEditorCompatibility> {
  const summary = await validateDocxPackage(buffer);
  if (summary.conformance === 'strict') return { editable: false, reasons: ['Strict Open XML documents are currently available as read-only in the browser editor.'] };
  if (summary.mainDocumentPart !== 'word/document.xml') return { editable: false, reasons: ['This document uses a package layout that is not supported for safe browser editing.'] };
  const zip = await JSZip.loadAsync(buffer);
  const manifest = zip.file('[Content_Types].xml');
  if (!manifest || !zip.file('_rels/.rels')) return { editable: false, reasons: ['This document uses a package layout that is not supported for safe browser editing.'] };
  if (Object.keys(zip.files).some((name) => name.toLowerCase() === 'word/_rels/document.xml.rels' && name !== 'word/_rels/document.xml.rels')) {
    return { editable: false, reasons: ['This document uses a package layout that is not supported for safe browser editing.'] };
  }
  const parts = new Set(['word/document.xml']);
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (tag.uri !== TYPES_NS || tag.local !== 'Override') return;
    const type = tag.attributes.ContentType?.value;
    const partName = tag.attributes.PartName?.value;
    if (type && REWRITTEN_TYPES.has(type) && partName?.startsWith('/')) parts.add(partName.slice(1));
  });
  parser.write(decodeXml(await manifest.async('uint8array'))).close();
  const reasons = new Set<string>();
  // The installed parser follows relationships even when a producer assigns a
  // generic content type. Inspect their targets as well as declared overrides.
  const relationships = zip.file('word/_rels/document.xml.rels');
  if (relationships) {
    const relParser = new SaxesParser({ xmlns: true });
    relParser.on('opentag', (tag) => {
      if (tag.uri !== RELS_NS || tag.local !== 'Relationship' || !REWRITTEN_RELATIONSHIPS.has(tag.attributes.Type?.value.split('/').at(-1) ?? '')) return;
      const target = tag.attributes.Target?.value;
      if (!target || tag.attributes.TargetMode?.value === 'External') {
        reasons.add('This document uses a package layout that is not supported for safe browser editing.');
        return;
      }
      const resolved = new URL(target, 'https://office-package.invalid/word/document.xml');
      parts.add(decodeURIComponent(resolved.pathname.slice(1)));
    });
    relParser.write(decodeXml(await relationships.async('uint8array'))).close();
  }
  for (const part of parts) {
    const entry = zip.file(part);
    if (!entry || (part !== 'word/document.xml' && !/^word\/(?:header\d*|footer\d*|comments|commentsExtended|commentsIds|commentsExtensible)\.xml$/u.test(part))) {
      reasons.add('This document uses a package layout that is not supported for safe browser editing.');
      continue;
    }
    inspectPart(decodeXml(await entry.async('uint8array')), reasons);
  }
  return { editable: reasons.size === 0, reasons: [...reasons] };
}
