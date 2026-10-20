import 'server-only';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { File as ZipFile } from 'unzipper';
import type { CanvasMigrationManifest, MigrationImportWorkspaceMapping, MigrationFileEntry } from './types';
import { assertMigrationArchivePath } from './archive';
import { getSelectedMigrationComponentPaths } from './component-paths';
import { isPortableCredentialPath } from './secret-export-policy';

export type RestoreFile = { source: MigrationFileEntry; zip: ZipFile; target: string | null;
  workspaceId: string | null; workspacePath: string | null };

export function resolveRestoreTarget(dataRoot: string, relative: string): string {
  assertMigrationArchivePath('data/' + relative);
  const absolute = path.resolve(dataRoot, relative);
  if (!absolute.startsWith(path.resolve(dataRoot) + path.sep)) throw new Error('Restore target escapes the data root.');
  return absolute;
}

export async function assertRestoreAncestors(dataRoot: string, relative: string): Promise<void> {
  const parts = relative.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const filename = resolveRestoreTarget(dataRoot, parts.slice(0, index).join('/'));
    const stat = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink() || (index < parts.length && stat && !stat.isDirectory())) throw new Error('A restore target has a symbolic link or non-directory ancestor.');
  }
}

export function buildRestoreFilePlan(input: {
  dataRoot: string; manifest: CanvasMigrationManifest; entries: ZipFile[]; mappings: MigrationImportWorkspaceMapping[];
}): { files: RestoreFile[]; directories: string[] } {
  const { manifest, entries, mappings, dataRoot } = input;
  const targetRoots = new Set<string>();
  for (const mapping of mappings) {
    if (mapping.status !== 'mapped' || !mapping.targetPath) throw new Error('Restore workspace mapping is unresolved.');
    const root = mapping.targetPath.replace(/\/$/u, '').normalize('NFC').toLowerCase();
    if (targetRoots.has(root)) throw new Error('Different source workspaces cannot overwrite the same target workspace.');
    targetRoots.add(root);
  }
  const roots = getSelectedMigrationComponentPaths(manifest.components);
  const translate = (archivePath: string, component?: string): { target: string; workspaceId: string | null; workspacePath: string | null } | null => {
    assertMigrationArchivePath(archivePath);
    const name = archivePath.replace(/\/$/u, '');
    const root = roots.filter(r => (!component || r.component === component)
      && (name === r.archiveRoot || name.startsWith(r.archiveRoot + '/')))
      .sort((a, b) => b.archiveRoot.length - a.archiveRoot.length)[0];
    if (!root) return null;
    if (root.component === 'workspace') {
      const mapping = mappings.filter(m => name === m.sourcePath || name.startsWith(m.sourcePath + '/'))
        .sort((a, b) => b.sourcePath.length - a.sourcePath.length)[0];
      if (!mapping?.targetPath) return null;
      const suffix = name.slice(mapping.sourcePath.length).replace(/^\//u, '');
      const target = mapping.targetPath.slice('data/'.length) + (suffix ? '/' + suffix : '');
      return { target, workspaceId: mapping.targetWorkspaceId, workspacePath: suffix || null };
    }
    const relative = name.slice(root.archiveRoot.length).replace(/^\//u, '');
    if (root.includeRelativePath && !root.includeRelativePath(relative + (archivePath.endsWith('/') ? '/' : ''))) return null;
    return { target: name.slice('data/'.length), workspaceId: null, workspacePath: null };
  };
  const actualFiles = entries.filter(entry => entry.type === 'File' && entry.path !== 'manifest.json');
  const byPath = new Map(actualFiles.map(entry => [entry.path, entry]));
  if (manifest.fileCount !== manifest.files.length || actualFiles.length !== manifest.files.length
    || manifest.totalBytes !== manifest.files.reduce((sum, file) => sum + file.size, 0)) throw new Error('Migration manifest does not describe the complete archive.');
  const seen = new Set<string>();
  const files = manifest.files.map(source => {
    if (!manifest.components[source.component] || !Number.isSafeInteger(source.size) || source.size < 0
      || (source.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(source.sha256))) throw new Error('Invalid migration file metadata.');
    const zip = byPath.get(source.archivePath);
    if (!zip || zip.uncompressedSize !== source.size || seen.has(zip.path)) throw new Error('Migration file is missing, duplicated or has a different size.');
    seen.add(zip.path);
    if (source.component === 'secrets' && source.archivePath === 'data/reconnect-manifest.json') return { source, zip, target: null, workspaceId: null, workspacePath: null };
    if (source.component === 'database' && source.archivePath === manifest.database?.artifactPath) return { source, zip, target: null, workspaceId: null, workspacePath: null };
    const target = translate(source.archivePath, source.component);
    if (!target) throw new Error('Migration file is outside its selected component or approved workspace mapping.');
    if (isPortableCredentialPath(resolveRestoreTarget(dataRoot, target.target), dataRoot)) throw new Error('Portable migration cannot replace managed credentials.');
    return { source, zip, ...target };
  });
  const targets = new Set<string>();
  for (const file of files) {
    if (!file.target) continue;
    const key = file.target.normalize('NFC').toLowerCase();
    if (targets.has(key)) throw new Error('Migration files have conflicting target paths.');
    targets.add(key);
  }
  const directories = new Set<string>();
  for (const entry of entries.filter(e => e.type === 'Directory')) {
    const target = translate(entry.path);
    if (target && !isPortableCredentialPath(resolveRestoreTarget(dataRoot, target.target), dataRoot)) directories.add(target.target);
  }
  for (const target of [...directories, ...files.map(f => f.target).filter((value): value is string => Boolean(value))]) {
    let parent = path.posix.dirname(target);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  if ([...directories].some(directory => targets.has(directory.normalize('NFC').toLowerCase()))) throw new Error('A migration target is both a file and a directory.');
  return { files, directories: [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)) };
}
