export function getExtension(filePath: string): string {
  const parts = filePath.split('.');
  if (parts.length <= 1) return '';
  return parts[parts.length - 1].toLowerCase();
}

export function getParentDirectory(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0) return '.';
  return trimmed.slice(0, lastSlash);
}

export function getParentDirectories(filePath: string): string[] {
  const parts = filePath.split('/').filter(Boolean);
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    dirs.push(parts.slice(0, i).join('/'));
  }
  return dirs;
}

export function joinWorkspacePath(parent: string, name: string): string {
  const normalizedParent = parent === '.' ? '' : parent.replace(/\/+$/, '');
  const normalizedName = name.replace(/^\/+/, '');
  if (!normalizedParent) return normalizedName;
  return `${normalizedParent}/${normalizedName}`;
}

export function getDirectoryDepth(dirPath: string): number {
  if (dirPath === '.') return 0;
  return dirPath.split('/').filter(Boolean).length;
}

export function getDirectoryPathChain(dirPath: string): string[] {
  if (dirPath === '.') return [];

  const segments = dirPath.split('/').filter(Boolean);
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

export function normalizeWorkspacePathParam(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.includes('\0')) return null;

  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.join('/');
}
