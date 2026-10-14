import 'server-only';

import { createHash } from 'node:crypto';
import fs, { constants, type BigIntStats } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Mechanical IO only. Neither a descriptor nor this API grants file authority.
 * Consumers own every returned FD and must bind root/name/inode/hash/lifetime
 * before and after IO, including the genuine authorization/publication final. */
export type PrivateFdFileProfile = Readonly<{ dev: string; ino: string; uid: number; mode: 0o600 }>;
export type FdPublicationBackend = Readonly<{
  apiVersion: 1; backend: 'linux-proc-fd' | 'darwin-node-api8';
  openDirectoryAt(parentFd: number, name: string): number;
  openFileAt(parentFd: number, name: string, mode: 'readonly' | 'private-wx'): number;
  mkdirAt(parentFd: number, name: string, mode: 0o700 | 0o755): void;
  linkAt(sourceFd: number, sourceName: string, targetFd: number, targetName: string): void;
  unlinkFileAt(parentFd: number, name: string, expected: PrivateFdFileProfile): void;
  hasExactNameAt(parentFd: number, name: string): boolean;
}>;
export class FdPublicationError extends Error {
  constructor(readonly code: string) { super('The descriptor operation could not be confirmed.'); this.name = 'FdPublicationError'; }
}
const fail = (code: string): never => { throw new FdPublicationError(code); };
const limit = 100_000;
const maxArtifactBytes = 2 * 1024 * 1024;
const syscallCodes = new Set(['EBADF', 'EEXIST', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EINVAL', 'EACCES', 'EPERM', 'EXDEV', 'ENOSPC', 'EMFILE', 'ENFILE', 'EROFS', 'ENAMETOOLONG', 'EIO', 'EOVERFLOW']);
const privateCodes = new Set(['FD_PUBLICATION_INVALID_INPUT', 'FD_PUBLICATION_NAMESPACE_CHANGED', 'FD_PUBLICATION_NON_REGULAR',
  'FD_PUBLICATION_PROFILE_CHANGED', 'FD_PUBLICATION_SCAN_LIMIT', 'FD_PUBLICATION_UNAVAILABLE', 'FD_PUBLICATION_MANIFEST_INVALID']);
function guarded<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const code = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    // Do not export OS messages/causes containing a private record name/path.
    throw new FdPublicationError(typeof code === 'string' && (syscallCodes.has(code) || privateCodes.has(code)) ? code : 'FD_PUBLICATION_UNCONFIRMED');
  }
}
function arity(actual: number, expected: number): void { if (actual !== expected) fail('FD_PUBLICATION_INVALID_INPUT'); }
function component(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value) > 255 || Buffer.from(value).toString('utf8') !== value) fail('FD_PUBLICATION_INVALID_INPUT');
}
function directory(fd: unknown): BigIntStats {
  if (typeof fd !== 'number' || !Number.isInteger(fd) || fd < 3 || fd > 2_147_483_647) return fail('FD_PUBLICATION_INVALID_INPUT');
  const info = fs.fstatSync(fd, { bigint: true });
  if (!info.isDirectory() || info.uid !== BigInt(process.geteuid!()) || info.nlink < BigInt(1) || (info.mode & BigInt(0o022)) !== BigInt(0)) fail('FD_PUBLICATION_NAMESPACE_CHANGED');
  return info;
}
function regular(info: BigIntStats): void {
  if (!info.isFile() || info.uid !== BigInt(process.geteuid!()) || info.nlink < BigInt(1) || info.nlink > BigInt(2)
    || (info.mode & BigInt(0o022)) !== BigInt(0)) fail('FD_PUBLICATION_NON_REGULAR');
}
function profile(value: PrivateFdFileProfile): void {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 4
    || !['dev', 'ino', 'uid', 'mode'].every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && 'value' in descriptor;
    }) || typeof value.dev !== 'string' || typeof value.ino !== 'string'
    || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value.dev) || !/^[1-9][0-9]{0,19}$/u.test(value.ino)
    || BigInt(value.dev) > BigInt('18446744073709551615') || BigInt(value.ino) > BigInt('18446744073709551615')
    || !Number.isSafeInteger(value.uid) || value.uid !== process.geteuid!() || value.mode !== 0o600) fail('FD_PUBLICATION_INVALID_INPUT');
}
function anchor(fd: number, name?: string): string {
  directory(fd); if (name !== undefined) component(name);
  return `/proc/self/fd/${fd}${name === undefined ? '' : `/${name}`}`;
}
function linuxBackend(): FdPublicationBackend {
  return Object.freeze({ apiVersion: 1, backend: 'linux-proc-fd',
    openDirectoryAt(fd: number, name: string): number {
      arity(arguments.length, 2);
      return guarded(() => {
        const result = fs.openSync(anchor(fd, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { directory(result); return result; } catch (error) { fs.closeSync(result); throw error; }
      });
    },
    openFileAt(fd: number, name: string, mode: 'readonly' | 'private-wx'): number {
      arity(arguments.length, 3);
      return guarded(() => {
        if (!['readonly', 'private-wx'].includes(mode)) fail('FD_PUBLICATION_INVALID_INPUT');
        const flags = mode === 'readonly' ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
        const result = fs.openSync(anchor(fd, name), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        try { regular(fs.fstatSync(result, { bigint: true })); return result; } catch (error) { fs.closeSync(result); throw error; }
      });
    },
    mkdirAt(fd: number, name: string, mode: 0o700 | 0o755): void {
      arity(arguments.length, 3);
      guarded(() => { if (![0o700, 0o755].includes(mode)) fail('FD_PUBLICATION_INVALID_INPUT'); fs.mkdirSync(anchor(fd, name), { mode }); });
    },
    linkAt(sourceFd: number, sourceName: string, targetFd: number, targetName: string): void {
      arity(arguments.length, 4);
      guarded(() => { const source = anchor(sourceFd, sourceName), target = anchor(targetFd, targetName);
        regular(fs.lstatSync(source, { bigint: true })); fs.linkSync(source, target); });
    },
    unlinkFileAt(fd: number, name: string, expected: PrivateFdFileProfile): void {
      arity(arguments.length, 3);
      guarded(() => {
        profile(expected); const filename = anchor(fd, name), info = fs.lstatSync(filename, { bigint: true }); regular(info);
        if (info.dev.toString() !== expected.dev || info.ino.toString() !== expected.ino || info.uid !== BigInt(expected.uid)
          || (info.mode & BigInt(0o7777)) !== BigInt(expected.mode)) fail('FD_PUBLICATION_PROFILE_CHANGED');
        fs.unlinkSync(filename);
      });
    },
    hasExactNameAt(fd: number, name: string): boolean {
      arity(arguments.length, 2);
      return guarded(() => {
        component(name); const opened = fs.opendirSync(anchor(fd)); let count = 0;
        try { for (let entry = opened.readSync(); entry; entry = opened.readSync()) {
          if (++count > limit) fail('FD_PUBLICATION_SCAN_LIMIT'); if (entry.name === name) return true;
        } return false; } finally { opened.closeSync(); }
      });
    },
  });
}

type DarwinAddon = Readonly<{ apiVersion: 1; napiVersion: 8; platform: 'darwin'; arch: string;
  openDirectoryAt: (fd: number, name: string) => number; openFileAt: (fd: number, name: string, mode: string) => number;
  mkdirAt: (fd: number, name: string, mode: number) => void; linkAt: FdPublicationBackend['linkAt'];
  unlinkFileAt: (fd: number, name: string, dev: string, ino: string, uid: number, mode: number) => void;
  hasExactNameAt: FdPublicationBackend['hasExactNameAt'] }>;
const methods = ['openDirectoryAt', 'openFileAt', 'mkdirAt', 'linkAt', 'unlinkFileAt', 'hasExactNameAt'] as const;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function artifact(filename: string): Buffer {
  const fd = fs.openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maxArtifactBytes || (before.mode & 0o022)) fail('FD_PUBLICATION_MANIFEST_INVALID');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!read) fail('FD_PUBLICATION_MANIFEST_INVALID'); offset += read; }
    const after = fs.fstatSync(fd), named = fs.lstatSync(filename);
    if ([after, named].some(value => !value.isFile() || value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size
      || value.mtimeMs !== before.mtimeMs || value.ctimeMs !== before.ctimeMs || value.mode !== before.mode || value.nlink !== 1)) fail('FD_PUBLICATION_MANIFEST_INVALID');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function darwinBackend(): FdPublicationBackend {
  const root = path.resolve(process.env.CANVAS_APP_ROOT?.trim() || process.cwd());
  const directoryPath = path.join(root, 'native/fd-publication', `darwin-${process.arch}`);
  const manifestBytes = artifact(path.join(directoryPath, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  const keys = ['version', 'apiVersion', 'napiVersion', 'platform', 'arch', 'sourceSha256', 'binarySha256', 'nodeVersion', 'compiler'];
  if (!manifest || Object.getPrototypeOf(manifest) !== Object.prototype || Reflect.ownKeys(manifest).length !== keys.length
    || keys.some(key => !Object.hasOwn(manifest, key)) || JSON.stringify(manifest, null, 2) + '\n' !== manifestBytes.toString('utf8')
    || manifest.version !== 1 || manifest.apiVersion !== 1 || manifest.napiVersion !== 8 || manifest.platform !== 'darwin' || manifest.arch !== process.arch
    || typeof manifest.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.sourceSha256)
    || typeof manifest.binarySha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.binarySha256)
    || typeof manifest.nodeVersion !== 'string' || typeof manifest.compiler !== 'string' || Number(process.versions.napi) < 8) fail('FD_PUBLICATION_MANIFEST_INVALID');
  const binaryPath = path.join(directoryPath, 'fd-publication.node'), binary = artifact(binaryPath);
  if (sha(binary) !== manifest.binarySha256 || sha(artifact(path.join(directoryPath, 'source.c'))) !== manifest.sourceSha256) fail('FD_PUBLICATION_MANIFEST_INVALID');
  const addon = createRequire(path.join(root, 'package.json'))(binaryPath) as DarwinAddon;
  if (!addon || Object.getPrototypeOf(addon) !== Object.prototype || Reflect.ownKeys(addon).length !== methods.length + 4
    || [...methods, 'apiVersion', 'napiVersion', 'platform', 'arch'].some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(addon, key);
      return !descriptor?.enumerable || !('value' in descriptor);
    }) || addon.apiVersion !== 1 || addon.napiVersion !== 8
    || addon.platform !== 'darwin' || addon.arch !== process.arch || methods.some(key => typeof addon[key] !== 'function')
    || sha(artifact(binaryPath)) !== manifest.binarySha256) fail('FD_PUBLICATION_MANIFEST_INVALID');
  Object.freeze(addon);
  return Object.freeze({ apiVersion: 1, backend: 'darwin-node-api8',
    openDirectoryAt(fd: number, name: string) { arity(arguments.length, 2); return guarded(() => { directory(fd); component(name); return addon.openDirectoryAt(fd, name); }); },
    openFileAt(fd: number, name: string, mode: 'readonly' | 'private-wx') { arity(arguments.length, 3); return guarded(() => { directory(fd); component(name); return addon.openFileAt(fd, name, mode); }); },
    mkdirAt(fd: number, name: string, mode: 0o700 | 0o755) { arity(arguments.length, 3); guarded(() => { directory(fd); component(name); addon.mkdirAt(fd, name, mode); }); },
    linkAt(sourceFd: number, sourceName: string, targetFd: number, targetName: string) { arity(arguments.length, 4); guarded(() => { directory(sourceFd); directory(targetFd); component(sourceName); component(targetName); addon.linkAt(sourceFd, sourceName, targetFd, targetName); }); },
    unlinkFileAt(fd: number, name: string, expected: PrivateFdFileProfile) { arity(arguments.length, 3); guarded(() => { directory(fd); component(name); profile(expected); addon.unlinkFileAt(fd, name, expected.dev, expected.ino, expected.uid, expected.mode); }); },
    hasExactNameAt(fd: number, name: string) { arity(arguments.length, 2); return guarded(() => { directory(fd); component(name); return addon.hasExactNameAt(fd, name); }); },
  });
}

/** Call before native DML. No alternate backend, path, compiler or child fallback. */
export function getFdPublicationBackend(): FdPublicationBackend {
  arity(arguments.length, 0);
  return guarded(() => {
    if (process.platform === 'linux') {
      if (!fs.statSync('/proc/self/fd').isDirectory()) fail('FD_PUBLICATION_UNAVAILABLE');
      return linuxBackend();
    }
    if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) return darwinBackend();
    return fail('FD_PUBLICATION_UNAVAILABLE');
  });
}
