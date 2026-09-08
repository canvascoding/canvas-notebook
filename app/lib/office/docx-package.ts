import { crc32, inflateRaw } from 'node:zlib';
import { SaxesParser, type SaxesTagNS } from 'saxes';

/** Limits apply before inflation, and each actual output is bounded by its checked size. */
export const DOCX_PACKAGE_LIMITS = Object.freeze({
  compressedBytes: 32 * 1024 * 1024,
  uncompressedBytes: 128 * 1024 * 1024,
  entryBytes: 64 * 1024 * 1024,
  xmlPartBytes: 16 * 1024 * 1024,
  entries: 4096,
  entryNameBytes: 1024,
  xmlDepth: 256,
  xmlElements: 1_000_000,
});

export type DocxPackageErrorCode =
  | 'DOCX_INVALID_PACKAGE'
  | 'DOCX_PACKAGE_TOO_LARGE'
  | 'DOCX_UNSUPPORTED_PACKAGE';

export class DocxPackageValidationError extends Error {
  readonly status: number;

  constructor(readonly code: DocxPackageErrorCode, message: string) {
    super(message);
    this.name = 'DocxPackageValidationError';
    this.status = code === 'DOCX_PACKAGE_TOO_LARGE' ? 413 : 422;
  }
}

export type DocxPackageSummary = {
  compressedBytes: number;
  uncompressedBytes: number;
  entryCount: number;
  partCount: number;
  xmlPartCount: number;
  mainDocumentPart: string;
  conformance: 'transitional' | 'strict';
};

const CONTENT_TYPES = '[Content_Types].xml';
const PACKAGE_RELS = '_rels/.rels';
const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const STRICT_WORD_NS = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const DOCUMENT_RELS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STRICT_DOCUMENT_RELS_NS = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const DOCUMENT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const RELATIONSHIPS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';

type ZipEntry = {
  name: string;
  key: string;
  directory: boolean;
  method: number;
  crc: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localOffset: number;
  dataOffset: number;
  endOffset: number;
};
type Relationship = { id: string; type: string; target: string; external: boolean };
type XmlBudget = { elements: number };

function invalid(message: string): never {
  throw new DocxPackageValidationError('DOCX_INVALID_PACKAGE', message);
}

function tooLarge(message: string): never {
  throw new DocxPackageValidationError('DOCX_PACKAGE_TOO_LARGE', message);
}

function unsupported(message: string): never {
  throw new DocxPackageValidationError('DOCX_UNSUPPORTED_PACKAGE', message);
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid('The DOCX package contains an invalid UTF-8 part name.');
  }
}

/** OPC part names are compared case-insensitively; reject ambiguous/unsafe encodings. */
function partKey(name: string): string {
  if (!name || name.startsWith('/') || /[\\\u0000-\u0020\u007f:?#]/u.test(name) || /%(?:2f|5c)/iu.test(name)) {
    invalid('The DOCX package contains an unsafe part name.');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return invalid('The DOCX package contains an invalid part URI.');
  }
  if (/[\\\u0000-\u001f\u007f:?#]/u.test(decoded)) invalid('The DOCX package contains an unsafe part name.');
  if (decoded.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    invalid('The DOCX package contains a traversing or empty part name.');
  }
  return decoded.toLowerCase();
}

function checkExtraFields(buffer: Buffer, start: number, end: number, name: string, rawName: Buffer): void {
  for (let offset = start; offset < end;) {
    if (offset + 4 > end) invalid('The DOCX ZIP extra fields are truncated.');
    const id = buffer.readUInt16LE(offset);
    const length = buffer.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > end) invalid('The DOCX ZIP extra fields are truncated.');
    if (id === 0x0001) unsupported('ZIP64 DOCX packages are not supported.');
    if (id === 0x9901) unsupported('Encrypted DOCX packages are not supported.');
    // Some ZIP readers prefer this Unicode path over the header filename.
    if (id === 0x7075 && (length < 5 || buffer[offset] !== 1
      || buffer.readUInt32LE(offset + 1) !== crc32(rawName)
      || decodeUtf8(buffer.subarray(offset + 5, offset + length)) !== name)) {
      invalid('The DOCX ZIP contains conflicting part names.');
    }
    offset += length;
  }
}

/** Parse both ZIP directories before decompressing anything; never trust only one header. */
function readZipDirectory(buffer: Buffer): ZipEntry[] {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) invalid('The document is not a complete DOCX ZIP package.');
  if (buffer.length > DOCX_PACKAGE_LIMITS.compressedBytes) tooLarge('The DOCX package exceeds the compressed size limit.');
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 65535); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) invalid('The DOCX ZIP end directory is missing or truncated.');
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryBytes = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff) {
    unsupported('ZIP64 DOCX packages are not supported.');
  }
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0 || buffer.readUInt16LE(eocd + 8) !== count) {
    unsupported('Split DOCX ZIP packages are not supported.');
  }
  if (!count) invalid('The DOCX package is empty.');
  if (count > DOCX_PACKAGE_LIMITS.entries) tooLarge('The DOCX package contains too many entries.');
  if (directoryOffset + directoryBytes !== eocd) invalid('The DOCX ZIP directory has inconsistent bounds.');
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) invalid('The DOCX ZIP directory is malformed.');
    const version = buffer.readUInt16LE(offset + 6);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedBytes = buffer.readUInt32LE(offset + 20);
    const uncompressedBytes = buffer.readUInt32LE(offset + 24);
    const nameBytes = buffer.readUInt16LE(offset + 28);
    const extraBytes = buffer.readUInt16LE(offset + 30);
    const commentBytes = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (nextOffset > eocd || !nameBytes) invalid('The DOCX ZIP entry is truncated or unnamed.');
    if (nameBytes > DOCX_PACKAGE_LIMITS.entryNameBytes) tooLarge('A DOCX part name exceeds the size limit.');
    if (flags & (0x0001 | 0x0040 | 0x2000)) unsupported('Encrypted DOCX packages are not supported.');
    if (version > 20 || flags & ~0x080e || (method !== 0 && method !== 8)) unsupported('The DOCX ZIP uses an unsupported compression feature.');
    if (buffer.readUInt16LE(offset + 34) !== 0) unsupported('Split DOCX ZIP packages are not supported.');
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff || localOffset === 0xffffffff) unsupported('ZIP64 DOCX packages are not supported.');
    expandedBytes += uncompressedBytes;
    if (uncompressedBytes > DOCX_PACKAGE_LIMITS.entryBytes || expandedBytes > DOCX_PACKAGE_LIMITS.uncompressedBytes) {
      tooLarge('The DOCX package exceeds the expanded size limit.');
    }
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameBytes);
    if (!(flags & 0x0800) && rawName.some((byte) => byte >= 128)) unsupported('Non-UTF-8 DOCX part names are not supported.');
    const name = decodeUtf8(rawName);
    const directory = name.endsWith('/');
    const key = partKey(directory ? name.slice(0, -1) : name);
    if (names.has(key)) invalid('The DOCX package contains duplicate or ambiguous part names.');
    names.add(key);
    if (directory && uncompressedBytes !== 0) invalid('A DOCX ZIP directory contains file data.');
    const fileType = (buffer.readUInt32LE(offset + 38) >>> 16) & 0xf000;
    if (fileType && fileType !== 0x8000 && fileType !== 0x4000) unsupported('DOCX ZIP links and special files are not supported.');
    checkExtraFields(buffer, offset + 46 + nameBytes, offset + 46 + nameBytes + extraBytes, name, rawName);
    if (localOffset + 30 > directoryOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) invalid('The DOCX ZIP local header is missing.');
    const localNameBytes = buffer.readUInt16LE(localOffset + 26);
    const localExtraBytes = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameBytes + localExtraBytes;
    if (dataOffset + compressedBytes > directoryOffset || buffer.readUInt16LE(localOffset + 4) !== version
      || buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method
      || !buffer.subarray(localOffset + 30, localOffset + 30 + localNameBytes).equals(rawName)) {
      invalid('The DOCX ZIP local and central headers disagree.');
    }
    for (const [position, expected] of [[14, crc], [18, compressedBytes], [22, uncompressedBytes]]) {
      const actual = buffer.readUInt32LE(localOffset + position);
      if (actual !== expected && (!(flags & 0x0008) || actual !== 0)) invalid('The DOCX ZIP sizes or checksums disagree.');
    }
    checkExtraFields(buffer, localOffset + 30 + localNameBytes, dataOffset, name, rawName);
    let endOffset = dataOffset + compressedBytes;
    if (flags & 0x0008) {
      const starts = endOffset + 4 <= directoryOffset && buffer.readUInt32LE(endOffset) === 0x08074b50 ? [endOffset + 4, endOffset] : [endOffset];
      const descriptor = starts.find((start) => start + 12 <= directoryOffset && buffer.readUInt32LE(start) === crc
        && buffer.readUInt32LE(start + 4) === compressedBytes && buffer.readUInt32LE(start + 8) === uncompressedBytes);
      if (descriptor === undefined) invalid('The DOCX ZIP data descriptor is missing or inconsistent.');
      endOffset = descriptor + 12;
    }
    entries.push({ name, key, directory, method, crc, compressedBytes, uncompressedBytes, localOffset, dataOffset, endOffset });
    offset = nextOffset;
  }
  if (offset !== eocd) invalid('The DOCX ZIP directory contains unlisted entries or trailing data.');
  let localEnd = 0;
  for (const entry of [...entries].sort((a, b) => a.localOffset - b.localOffset)) {
    if (entry.localOffset !== localEnd) invalid('The DOCX ZIP contains overlapping, hidden, or displaced entries.');
    localEnd = entry.endOffset;
  }
  if (localEnd !== directoryOffset) invalid('The DOCX ZIP contains unlisted file data.');
  return entries;
}

async function readEntry(buffer: Buffer, entry: ZipEntry): Promise<Buffer> {
  const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedBytes);
  let output: Buffer;
  if (entry.method === 0) {
    output = compressed;
  } else {
    try {
      output = await new Promise<Buffer>((resolve, reject) => {
        // The native limit prevents forged small ZIP size fields from expanding a bomb.
        inflateRaw(compressed, { maxOutputLength: Math.max(1, entry.uncompressedBytes), info: true }, (error, value) => {
          if (error) return reject(error);
          const result = value as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
          if (result.engine.bytesWritten !== compressed.length) return reject(new Error('Trailing compressed data'));
          resolve(result.buffer);
        });
      });
    } catch {
      return invalid('The DOCX ZIP compressed data is invalid or exceeds its declared size.');
    }
  }
  if (output.length !== entry.uncompressedBytes || crc32(output) !== entry.crc) invalid('The DOCX ZIP data size or checksum is invalid.');
  return output;
}

function parseXml(bytes: Buffer, budget: XmlBudget, onOpen: (tag: SaxesTagNS, depth: number) => void, structuralOnly = false): void {
  if (bytes.length > DOCX_PACKAGE_LIMITS.xmlPartBytes) tooLarge('A DOCX XML part exceeds the size limit.');
  let encoding = 'utf-8';
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)) encoding = 'utf-16le';
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)) encoding = 'utf-16be';
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    const parser = new SaxesParser({ xmlns: true });
    let depth = 0;
    parser.on('error', () => invalid('A DOCX XML part is malformed.'));
    parser.on('doctype', () => invalid('DOCX XML parts must not contain document type declarations.'));
    if (structuralOnly) {
      const checkText = (value: string) => { if (value.trim()) invalid('A DOCX manifest or relationship part contains unexpected text.'); };
      parser.on('text', checkText);
      parser.on('cdata', checkText);
    }
    parser.on('xmldecl', (declaration) => {
      const declared = declaration.encoding?.toLowerCase().replaceAll('-', '');
      const actual = encoding.replaceAll('-', '');
      const matches = !declared || declared === actual || (declared === 'utf16' && actual.startsWith('utf16'))
        || (declared === 'usascii' && actual === 'utf8' && !bytes.some((byte) => byte >= 128));
      if (!matches || (declaration.version && declaration.version !== '1.0')) invalid('A DOCX XML part has an unsupported or inconsistent XML encoding/version.');
    });
    parser.on('opentag', (tag) => {
      depth++;
      budget.elements++;
      if (depth > DOCX_PACKAGE_LIMITS.xmlDepth || budget.elements > DOCX_PACKAGE_LIMITS.xmlElements) tooLarge('The DOCX XML complexity exceeds the limit.');
      onOpen(tag, depth);
    });
    parser.on('closetag', () => { depth--; });
    parser.write(text).close();
  } catch (error) {
    if (error instanceof DocxPackageValidationError) throw error;
    invalid('A DOCX XML part is malformed or has invalid character encoding.');
  }
}

function attribute(tag: SaxesTagNS, name: string): string | undefined {
  const value = tag.attributes[name];
  return value && value.uri === '' ? value.value : undefined;
}

function contentTypes(bytes: Buffer, budget: XmlBudget): { defaults: Map<string, string>; overrides: Map<string, string> } {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  parseXml(bytes, budget, (tag, depth) => {
    if (tag.uri !== TYPES_NS || (depth === 1 ? tag.local !== 'Types' : depth !== 2 || !['Default', 'Override'].includes(tag.local))) {
      invalid('The DOCX content type manifest is malformed.');
    }
    if (depth === 1) return;
    const value = attribute(tag, 'ContentType');
    if (!value || !value.includes('/') || /\s/u.test(value)) invalid('The DOCX manifest contains an invalid content type.');
    if (tag.local === 'Default') {
      const extension = attribute(tag, 'Extension');
      if (!extension || /[.\/\\\s]/u.test(extension) || defaults.has(extension.toLowerCase())) invalid('The DOCX manifest contains duplicate or invalid default content types.');
      defaults.set(extension.toLowerCase(), value);
    } else {
      const part = attribute(tag, 'PartName');
      if (!part?.startsWith('/')) invalid('The DOCX manifest contains an invalid part override.');
      const key = partKey(part.slice(1));
      if (overrides.has(key)) invalid('The DOCX manifest contains duplicate part overrides.');
      overrides.set(key, value);
    }
  }, true);
  return { defaults, overrides };
}

function relationships(bytes: Buffer, budget: XmlBudget): Relationship[] {
  const items: Relationship[] = [];
  const ids = new Set<string>();
  parseXml(bytes, budget, (tag, depth) => {
    if (tag.uri !== RELS_NS || (depth === 1 ? tag.local !== 'Relationships' : depth !== 2 || tag.local !== 'Relationship')) {
      invalid('A DOCX relationship part is malformed.');
    }
    if (depth === 1) return;
    const id = attribute(tag, 'Id');
    const type = attribute(tag, 'Type');
    const target = attribute(tag, 'Target');
    const mode = attribute(tag, 'TargetMode');
    if (!id || /\s/u.test(id) || ids.has(id) || !type || !target || /[\u0000-\u0020\u007f]/u.test(target)
      || (mode !== undefined && mode !== 'Internal' && mode !== 'External')) {
      invalid('A DOCX relationship contains missing, duplicate, or invalid attributes.');
    }
    try { new URL(type); } catch { invalid('A DOCX relationship has an invalid type URI.'); }
    ids.add(id);
    items.push({ id, type, target, external: mode === 'External' });
  }, true);
  return items;
}

function relationshipSource(name: string): string {
  if (name.toLowerCase() === PACKAGE_RELS) return '';
  const segments = name.split('/');
  const file = segments.pop();
  if (segments.pop()?.toLowerCase() !== '_rels' || !file?.toLowerCase().endsWith('.rels')) invalid('A DOCX relationship part has an invalid location.');
  return partKey([...segments, file.slice(0, -5)].join('/'));
}

function relationshipTarget(source: string, target: string): string {
  const path = target.split('#', 1)[0];
  if (!path) {
    if (source) return source;
    return invalid('A package relationship must target a document part.');
  }
  if (/[\\:?\u0000-\u0020\u007f]/u.test(path) || path.startsWith('//') || /%(?:2f|5c)/iu.test(path)) invalid('A DOCX relationship has an unsafe internal target.');
  const segments = path.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const segment of path.replace(/^\//u, '').split('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return invalid('A DOCX relationship has an invalid target URI.'); }
    if (decoded === '.') continue;
    if (decoded === '..') {
      if (!segments.length) invalid('A DOCX relationship escapes the package.');
      segments.pop();
    } else {
      if (!decoded || /[\\\u0000-\u001f\u007f:?#]/u.test(decoded)) invalid('A DOCX relationship has an unsafe internal target.');
      segments.push(decoded);
    }
  }
  // Source keys and target segments have each been decoded exactly once.
  return segments.join('/').toLowerCase();
}

/**
 * Validate one immutable snapshot, without extracting, fetching targets, or rewriting parts.
 * Callers must commit this same Buffer after validation, never re-read an agent's staging path.
 * ZIP layout: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */
export async function validateDocxPackage(buffer: Buffer): Promise<DocxPackageSummary> {
  const entries = readZipDirectory(buffer);
  const parts = new Map(entries.filter((entry) => !entry.directory).map((entry) => [entry.key, entry]));
  const manifest = parts.get(CONTENT_TYPES.toLowerCase());
  const packageRels = parts.get(PACKAGE_RELS);
  if (!manifest || !packageRels) invalid('The DOCX content type manifest or package relationships are missing.');
  if (manifest.uncompressedBytes > DOCX_PACKAGE_LIMITS.xmlPartBytes || packageRels.uncompressedBytes > DOCX_PACKAGE_LIMITS.xmlPartBytes) {
    tooLarge('A DOCX XML part exceeds the size limit.');
  }
  const budget: XmlBudget = { elements: 0 };
  const types = contentTypes(await readEntry(buffer, manifest), budget);
  const getType = (entry: ZipEntry) => types.overrides.get(entry.key) ?? types.defaults.get(entry.key.split('.').pop() ?? '');
  for (const key of types.overrides.keys()) {
    if (!parts.has(key)) invalid('The DOCX content type manifest refers to a missing part.');
  }
  for (const entry of parts.values()) {
    if (entry !== manifest && !getType(entry)) invalid('A DOCX part has no declared content type.');
    if ((entry.key.endsWith('.xml') || entry.key.endsWith('.rels') || getType(entry)?.endsWith('+xml') || getType(entry) === 'application/xml' || getType(entry) === 'text/xml')
      && entry.uncompressedBytes > DOCX_PACKAGE_LIMITS.xmlPartBytes) tooLarge('A DOCX XML part exceeds the size limit.');
  }
  const rels = new Map<string, Relationship[]>();
  rels.set('', relationships(await readEntry(buffer, packageRels), budget));
  const mainRelationships = rels.get('')!.filter((rel) => rel.type === `${DOCUMENT_RELS_NS}/officeDocument` || rel.type === `${STRICT_DOCUMENT_RELS_NS}/officeDocument`);
  if (mainRelationships.length !== 1 || mainRelationships[0].external) invalid('The DOCX package must contain exactly one internal main document relationship.');
  const mainKey = relationshipTarget('', mainRelationships[0].target);
  const main = parts.get(mainKey);
  if (!main || getType(main) !== DOCUMENT_CONTENT_TYPE) invalid('The DOCX package has no Word main document part.');
  const references = new Map<string, Set<string>>();
  let conformance: 'transitional' | 'strict' = 'transitional';
  let mainNamespace = WORD_NS;
  let bodyCount = 0;
  let xmlPartCount = 2;
  for (const entry of entries) {
    if (entry === manifest || entry === packageRels) continue;
    const bytes = await readEntry(buffer, entry);
    if (entry.directory) continue;
    const type = getType(entry)!;
    if (entry.key.endsWith('.rels')) {
      if (type !== RELATIONSHIPS_CONTENT_TYPE) invalid('A DOCX relationship part has an invalid content type.');
      const source = relationshipSource(entry.name);
      if (!parts.has(source) || source.endsWith('.rels')) invalid('A DOCX relationship source part is missing or invalid.');
      rels.set(source, relationships(bytes, budget));
      xmlPartCount++;
    } else if (entry === main || entry.key.endsWith('.xml') || type.endsWith('+xml') || type === 'application/xml' || type === 'text/xml') {
      const ids = new Set<string>();
      parseXml(bytes, budget, (tag, depth) => {
        if (entry === main) {
          if (depth === 1) {
            if (tag.local !== 'document' || (tag.uri !== WORD_NS && tag.uri !== STRICT_WORD_NS)) invalid('The DOCX main document has an invalid root element.');
            conformance = tag.uri === STRICT_WORD_NS ? 'strict' : 'transitional';
            mainNamespace = tag.uri;
          }
          if (depth === 2 && tag.local === 'body' && tag.uri === mainNamespace) bodyCount++;
        }
        for (const attr of Object.values(tag.attributes)) {
          if ((attr.uri === DOCUMENT_RELS_NS || attr.uri === STRICT_DOCUMENT_RELS_NS) && ['id', 'embed', 'link'].includes(attr.local)) ids.add(attr.value);
        }
      });
      if (ids.size) references.set(entry.key, ids);
      xmlPartCount++;
    }
  }
  if (bodyCount !== 1) invalid('The DOCX main document must contain one document body.');
  if (getType(packageRels) !== RELATIONSHIPS_CONTENT_TYPE) invalid('The DOCX package relationships have an invalid content type.');
  for (const [source, relationships] of rels) {
    for (const rel of relationships) {
      if (rel.external) continue;
      const target = relationshipTarget(source, rel.target);
      if (!parts.has(target) || target === CONTENT_TYPES.toLowerCase() || target.endsWith('.rels')) invalid('A DOCX relationship points to a missing or invalid part.');
    }
  }
  for (const [source, ids] of references) {
    const available = new Set(rels.get(source)?.map((rel) => rel.id));
    for (const id of ids) if (!available.has(id)) invalid('A DOCX XML part refers to a missing relationship.');
  }
  return {
    compressedBytes: buffer.length,
    uncompressedBytes: entries.reduce((sum, entry) => sum + entry.uncompressedBytes, 0),
    entryCount: entries.length,
    partCount: parts.size,
    xmlPartCount,
    mainDocumentPart: main.name,
    conformance,
  };
}
