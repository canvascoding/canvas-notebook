import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type NativeSource = { uri: string; name: string; size: number; mimeType: string };
type NativeSession = { id: string; targetDir: string; totalBytes: number; status: string; expiresAt: string; files: unknown[] };
export type NativeQueue = { id: string; targetDir: string; sources: NativeSource[]; nextIndex: number;
  pending: { source: NativeSource; session: NativeSession; limits: Record<string, number> } | null; skippedCount: number };
export type NativeScope = { instanceId: string; userId: string; workspaceId: string };
type Api = (pathname: string, init?: RequestInit) => Promise<Response>;
type Consumer = {
  persistFileUploadQueue(scope: NativeScope, queue: NativeQueue): Promise<void>;
  loadFileUploadQueue(scope: NativeScope): Promise<NativeQueue | null>;
  runFileUploadQueue(input: { scope: NativeScope; queue: NativeQueue; api: Api; prepareRequest: (pathname: string) => { url: string; headers: Record<string, string> };
    onQueueChange: (queue: NativeQueue) => void; onProgress: (progress: number) => void }): Promise<NativeQueue>;
};

/** Execute the original native API/transfer/activity/queue, replacing only the
 * unavailable Expo filesystem and Platform boundary. No product source rewrites. */
export function loadOriginalMobileUploadConsumer(sourceRoot: string) {
  const root = fs.realpathSync(sourceRoot), loaded = new Map<string, { exports: Record<string, unknown> }>();
  const hashes: Record<string, string> = {}, files = new Map<string, Uint8Array>(), directories = new Set<string>();
  const uri = (parts: Array<string | { uri: string }>) => parts.map((part, index) => {
    const value = typeof part === 'string' ? part : part.uri;
    return index ? value.replace(/^\/+|\/+$/gu, '') : value.replace(/\/+$/gu, '');
  }).join('/');
  class Directory {
    readonly uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(parts); }
    get exists() { return directories.has(this.uri); }
    create() { directories.add(this.uri); }
    list() { return [...files.keys()].filter(value => value.startsWith(`${this.uri}/`) && !value.slice(this.uri.length + 1).includes('/')).map(value => new File(value)); }
  }
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(parts); }
    get name() { return this.uri.split('/').pop()!; }
    get exists() { return files.has(this.uri); }
    get size() { return files.get(this.uri)?.length ?? 0; }
    create() { files.set(this.uri, new Uint8Array()); }
    write(value: string | Uint8Array) { files.set(this.uri, typeof value === 'string' ? new TextEncoder().encode(value) : value.slice()); }
    delete() { files.delete(this.uri); }
    async text() { return new TextDecoder().decode(files.get(this.uri)); }
    async copy(destination: File) { destination.write(files.get(this.uri)!); }
    async move(destination: File) { destination.write(files.get(this.uri)!); this.delete(); this.uri = destination.uri; }
    open() { assert.fail('The already uploaded native retry must not read or send another chunk.'); }
    createUploadTask() { assert.fail('The native retry must reuse the existing uploaded server file.'); }
  }
  function load(base: string): Record<string, unknown> {
    const filename = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(value => fs.existsSync(value) && fs.statSync(value).isFile());
    assert(filename && filename.startsWith(`${root}/src/`), 'Only the selected original native source tree may be loaded.');
    const cached = loaded.get(filename); if (cached) return cached.exports;
    const source = fs.readFileSync(filename, 'utf8'); hashes[path.relative(root, filename)] = createHash('sha256').update(source).digest('hex');
    const loadedModule = { exports: {} as Record<string, unknown> }; loaded.set(filename, loadedModule);
    const require = (specifier: string): unknown => {
      if (specifier === 'react-native') return { Platform: { OS: 'ios' } };
      if (specifier === 'expo-file-system') return { File, Directory, Paths: { document: 'file:///documents', cache: 'file:///cache' },
        FileMode: { ReadOnly: 'read' }, UploadType: { BINARY_CONTENT: 'binary' } };
      if (specifier.startsWith('@/')) return load(path.join(root, 'src', specifier.slice(2)));
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier));
      assert.fail(`Unexpected native dependency: ${specifier}`);
    };
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('require', 'module', 'exports', compiled)(require, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  const service = { ...load(path.join(root, 'src/features/files/transfer')), ...load(path.join(root, 'src/features/files/upload-queue')) } as unknown as Consumer;
  return { service, hashes, files };
}
