import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { repackDocx, type BlockContent, type Document, type Image } from '@eigenpal/docx-js-editor/core';

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const IMAGE_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

function images(blocks: BlockContent[]): Image[] {
  const result: Image[] = [];
  for (const block of blocks) {
    if (block.type === 'table') {
      for (const row of block.rows) for (const cell of row.cells) result.push(...images(cell.content));
    } else if (block.type === 'paragraph') {
      for (const run of block.content) if (run.type === 'run') {
        for (const content of run.content) if (content.type === 'drawing') result.push(content.image);
      }
    }
  }
  return result;
}

function sourcePath(target: string): string | null {
  if (target.startsWith('//') || /[\\?#\u0000-\u001f]/u.test(target)) return null;
  const url = new URL(target, 'https://office-package.invalid/word/document.xml');
  return url.origin === 'https://office-package.invalid' ? url.pathname.slice(1) : null;
}

function dataUrlBytes(source: string): Uint8Array | null {
  const match = /^data:image\/[^;,]+;base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(source);
  if (!match || match[1].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 16) return null;
  const binary = atob(match[1]);
  if (binary.length > MAX_IMAGE_BYTES) return null;
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function reuseImageRelationships(zip: JSZip, partName: string, blocks: BlockContent[]): Promise<void> {
  const slash = partName.lastIndexOf('/');
  const directory = partName.slice(0, slash + 1);
  const entry = zip.file(`${directory}_rels/${partName.slice(slash + 1)}.rels`);
  if (!entry) return;
  const targets = new Map<string, string>();
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (tag.uri !== RELS_NS || tag.local !== 'Relationship' || tag.attributes.Type?.value !== IMAGE_RELATIONSHIP || tag.attributes.TargetMode?.value === 'External') return;
    const id = tag.attributes.Id?.value;
    const target = tag.attributes.Target?.value;
    if (!id || !target) return;
    const url = new URL(target, `https://office-package.invalid/${partName}`);
    if (url.origin === 'https://office-package.invalid' && !url.search && !url.hash) targets.set(id, url.pathname.slice(1));
  });
  const xmlBytes = await entry.async('uint8array');
  const encoding = (xmlBytes[0] === 0xff && xmlBytes[1] === 0xfe) || (xmlBytes[0] === 0x3c && xmlBytes[1] === 0) ? 'utf-16le'
    : (xmlBytes[0] === 0xfe && xmlBytes[1] === 0xff) || (xmlBytes[0] === 0 && xmlBytes[1] === 0x3c) ? 'utf-16be' : 'utf-8';
  parser.write(new TextDecoder(encoding, { fatal: true }).decode(xmlBytes)).close();
  const comparisons = new Map<string, { source: string; matches: boolean }>();
  for (const image of images(blocks)) {
    if (!image.rId || !image.src?.startsWith('data:')) continue;
    const cached = comparisons.get(image.rId);
    if (cached?.source === image.src) {
      if (cached.matches) delete image.src;
      continue;
    }
    const target = targets.get(image.rId);
    const originalPart = target && (zip.file(target) ?? zip.file(decodeURIComponent(target)));
    if (!originalPart) continue;
    const currentBytes = dataUrlBytes(image.src);
    if (!currentBytes) continue;
    const originalBytes = await originalPart.async('uint8array');
    const matches = currentBytes.length === originalBytes.length && currentBytes.every((byte, index) => byte === originalBytes[index]);
    comparisons.set(image.rId, { source: image.src, matches });
    if (matches) {
      // The serializer treats every data URL as a new image, even with an existing
      // rId. Suppressing redundant src only on this clone keeps the original link.
      delete image.src;
    }
  }
}

/**
 * Serialize an editor snapshot whose originalBuffer passed the server's DOCX and
 * compatibility checks. Does not mutate the live editor or fetch external media.
 * Existing matching images keep their original relationship/part; changed and new
 * images retain their data URLs and are written by the editor's normal serializer.
 */
export async function serializeDocxForEditor(document: Document): Promise<ArrayBuffer> {
  if (!document.originalBuffer || document.originalBuffer.byteLength > MAX_ORIGINAL_BYTES) throw new Error('A bounded original DOCX snapshot is required to save this document.');
  const snapshot = structuredClone(document);
  const zip = await JSZip.loadAsync(snapshot.originalBuffer!);
  await reuseImageRelationships(zip, 'word/document.xml', snapshot.package.document.content);
  for (const headers of [snapshot.package.headers, snapshot.package.footers]) {
    if (!headers) continue;
    for (const [id, header] of headers) {
      const relationship = snapshot.package.relationships?.get(id);
      const partName = relationship?.target && sourcePath(relationship.target);
      if (partName) await reuseImageRelationships(zip, partName, header.content);
    }
  }
  return repackDocx(snapshot);
}
