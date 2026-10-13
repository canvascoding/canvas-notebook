import 'server-only';

import { constants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { CapabilityPackageError } from './contracts';
import { publicPluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';

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
function supportedImage(bytes: Buffer, contentType: string): boolean {
  if (contentType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (contentType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (contentType === 'image/gif') return /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString('ascii'));
  if (contentType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  const svg = bytes.toString('utf8');
  if (svg.includes('\uFFFD') || !/^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/iu.test(svg)
    || !/<\/svg\s*>\s*$/iu.test(svg) && !/<svg\b[^>]*\/\s*>\s*$/iu.test(svg)
    || /<!\s*(?:DOCTYPE|ENTITY)|<\s*(?:[\w.-]+:)?(?:script|foreignObject)\b|\bon[a-z]+\s*=|@import/iu.test(svg)) return false;
  for (const match of svg.matchAll(/(?:\b(?:[\w.-]+:)?(?:href|src))\s*=\s*(["'])(.*?)\1/giu)) {
    if (!match[2].startsWith('#') || /[&\p{Cc}]/u.test(match[2])) return false;
  }
  for (const match of svg.matchAll(/url\s*\(([^)]*)\)/giu)) {
    if (!match[1].trim().replace(/^["']|["']$/gu, '').startsWith('#')) return false;
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
