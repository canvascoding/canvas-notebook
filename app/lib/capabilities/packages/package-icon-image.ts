import 'server-only';
import { createPackageIconByteCache } from './package-icon-byte-cache';

import { constants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { CapabilityPackageError } from './contracts';
import { publicPluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import type { ExactCapabilityPackageInventory } from './io';

export const CAPABILITY_PACKAGE_ICON_MAX_BYTES = 2 * 1024 * 1024;
export type CapabilityPackageIconImage = {bytes: Buffer; contentType: string};
export type CapabilityPackageDeclaredIcon = CapabilityPackageIconImage | {url: string};
const imageTypes: Record<string, string> = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml'};
const invalid = () => new CapabilityPackageError('PACKAGE_PATH_INVALID', 'The declared package image is unavailable.', 400);
const changed = () => new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The package image changed. Inspect it again.', 409);
const same = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

function localImagePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\p{Cc}\p{Cf}\\]/u.test(value)) return undefined;
  const relative = value.startsWith('./') ? value.slice(2) : value;
  if (relative.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(relative)
    || relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) return undefined;
  return imageTypes[path.posix.extname(relative).toLowerCase()] ? relative : undefined;
}

/** Accept passive image bytes only; an extension never turns package text or credentials into an image. */
export function supportedImage(bytes: Buffer, contentType: string): boolean {
  if (contentType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (contentType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (contentType === 'image/gif') return /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString('ascii'));
  if (contentType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  const svg = bytes.toString('utf8');
  if (svg.includes('\uFFFD')) return false;
  // Consume each leading declaration/comment once. Repeated regex comments can
  // repartition their closing markers exponentially when no SVG root follows.
  let cursor = 0, declarationAllowed = true;
  while (cursor < svg.length) {
    while (cursor < svg.length && /\s/u.test(svg.charAt(cursor))) cursor += 1;
    if (declarationAllowed && svg.slice(cursor, cursor + 5).toLowerCase() === '<?xml') {
      const end = svg.indexOf('?', cursor + 5);
      if (end < 0 || svg.charAt(end + 1) !== '>') return false;
      cursor = end + 2; declarationAllowed = false;
      continue;
    }
    declarationAllowed = false;
    if (!svg.startsWith('<!--', cursor)) break;
    const end = svg.indexOf('-->', cursor + 4);
    if (end < 0) return false;
    cursor = end + 3;
  }
  if (!/^<svg\b/iu.test(svg.slice(cursor, cursor + 6))) return false;
  let end = svg.length;
  while (end > cursor && /\s/u.test(svg.charAt(end - 1))) end -= 1;
  if (svg.charAt(end - 1) !== '>') return false;
  let closing = end - 1;
  while (closing > cursor && /\s/u.test(svg.charAt(closing - 1))) closing -= 1;
  const closedRoot = closing >= cursor + 5 && svg.slice(closing - 5, closing).toLowerCase() === '</svg';
  const selfClosingRoot = svg.charAt(closing - 1) === '/' && svg.indexOf('>', cursor) === end - 1
    && svg.indexOf('<', cursor + 1) === -1;
  if (!closedRoot && !selfClosingRoot
    || /<!\s*(?:DOCTYPE|ENTITY)|<\s*(?:[\w.-]+:)?(?:script|foreignObject)\b|\bon[a-z]+\s*=|@import/iu.test(svg)) return false;
  // Whole name tokens and values advance once, rather than retrying a namespace
  // from every word boundary inside a long hyphenated token.
  const names = /[\w.:-]+/giu;
  let name: RegExpExecArray | null;
  while ((name = names.exec(svg)) !== null) {
    const parts = name[0].toLowerCase().split(':');
    if (!['href', 'src'].includes(parts[parts.length - 1] ?? '')) continue;
    if (parts.length > 2 || parts.some(part => !part)) return false;
    let position = names.lastIndex;
    while (position < svg.length && /\s/u.test(svg.charAt(position))) position += 1;
    if (svg.charAt(position) !== '=') continue;
    position += 1;
    while (position < svg.length && /\s/u.test(svg.charAt(position))) position += 1;
    const quote = svg.charAt(position);
    if (quote !== '"' && quote !== "'") return false;
    const valueEnd = svg.indexOf(quote, position + 1);
    if (valueEnd < 0) return false;
    const value = svg.slice(position + 1, valueEnd);
    if (!value.startsWith('#') || /[&\p{Cc}]/u.test(value)) return false;
    names.lastIndex = valueEnd + 1;
  }
  const urls = /url\s*\(/giu;
  while (urls.exec(svg) !== null) {
    const valueEnd = svg.indexOf(')', urls.lastIndex);
    if (valueEnd < 0) return false;
    const value = svg.slice(urls.lastIndex, valueEnd);
    if (value.includes('(') || !value.trim().replace(/^["']|["']$/gu, '').startsWith('#')) return false;
    urls.lastIndex = valueEnd + 1;
  }
  return true;
}

/** Internal primitive: caller must check fresh package/parent Read and source identity before and after reading. */
export async function readDeclaredCapabilityPackageImage(root: string, declaration: unknown): Promise<CapabilityPackageIconImage | null> {
  const relative = localImagePath(declaration);
  if (!relative) return null;
  const directory = path.resolve(root), rootStat = await fs.lstat(directory, {bigint: true});
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw invalid();
  const canonicalRoot = await fs.realpath(directory);
  const parts = relative.split('/'), observedDirectories: Array<{directory: string; stat: BigIntStats}> = [{directory, stat: rootStat}];
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = path.join(directory, ...parts.slice(0, index));
    let stat: BigIntStats;
    try { stat = await fs.lstat(ancestor, {bigint: true}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    observedDirectories.push({directory: ancestor, stat});
  }
  const file = path.join(directory, ...parts);
  let observed: BigIntStats;
  try { observed = await fs.lstat(file, {bigint: true}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== BigInt(1)) throw invalid();
  if (!observed.size || observed.size > BigInt(CAPABILITY_PACKAGE_ICON_MAX_BYTES)) return null;
  const canonicalFile = await fs.realpath(file);
  if (!canonicalFile.startsWith(canonicalRoot + path.sep)) throw invalid();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(observed, await handle.stat({bigint: true}))) throw changed();
    const bytes = Buffer.alloc(Number(observed.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw changed();
      offset += read.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || !same(observed, await handle.stat({bigint: true}))) throw changed();
    for (const entry of observedDirectories) {
      const current = await fs.lstat(entry.directory, {bigint: true});
      if (!current.isDirectory() || current.isSymbolicLink() || !same(entry.stat, current)) throw changed();
    }
    const contentType = imageTypes[path.posix.extname(relative).toLowerCase()];
    return supportedImage(bytes, contentType) ? {bytes, contentType} : null;
  } finally { await handle.close(); }
}

export async function readFirstDeclaredCapabilityPackageImage(root: string, declarations: readonly unknown[]): Promise<CapabilityPackageDeclaredIcon | null> {
  for (const declaration of declarations) {
    const publicIcon = publicPluginExtensionIcon(declaration, 'declared-image');
    if (publicIcon) return {url: publicIcon.url};
    const image = await readDeclaredCapabilityPackageImage(root, declaration);
    if (image) return image;
  }
  return null;
}

/** Caller holds fresh package/parent Read and an exact checksum-verified capture.
 * Both the declaration and returned image come from that same stable capture. */
const capturedImageBytes = createPackageIconByteCache();
export function readFirstCapturedCapabilityPackageImage(inventory: ExactCapabilityPackageInventory,
  declarations: readonly unknown[]): CapabilityPackageDeclaredIcon | null {
  for (const declaration of declarations) {
    const publicIcon = publicPluginExtensionIcon(declaration, 'declared-image');
    if (publicIcon) return { url: publicIcon.url };
    const relative = localImagePath(declaration);
    const file = relative ? inventory.files.find(file => file.relativePath === relative) : undefined;
    if (!relative || !file?.bytes.byteLength || file.bytes.byteLength > CAPABILITY_PACKAGE_ICON_MAX_BYTES) continue;
    const contentType = imageTypes[path.posix.extname(relative).toLowerCase()];
    const bytes = capturedImageBytes(inventory.checksum, contentType, file.bytes, () => supportedImage(file.bytes, contentType));
    if (bytes) return { bytes, contentType };
  }
  return null;
}
