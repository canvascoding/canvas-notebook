import { getExtension, getParentDirectory, isSameOrDescendantPath } from './path-utils';

const ASSETS = new Set(['css', 'js', 'mjs', 'json', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'woff', 'woff2', 'ttf', 'mp4', 'mp3']);
/** Include assets below referenced resource folders, including CSS/JS imports. */
export function previewMayDependOn(path: string, content: string, changedPath: string): boolean {
  if (path === changedPath || !ASSETS.has(getExtension(changedPath))) return false;
  if (!['html', 'htm', 'md', 'markdown', 'mdx'].includes(getExtension(path))) return false;
  const parent = getParentDirectory(path);
  if (parent === '.' || isSameOrDescendantPath(changedPath, parent)) return true;
  const base = new URL(path, 'https://workspace.invalid/');
  for (const match of content.matchAll(/(?:src|href)=["']([^"']+)["']|\]\(([^)\s]+)\)/gi)) {
    try {
      const dependency = new URL(match[1] ?? match[2], base);
      if (dependency.origin !== base.origin) continue;
      const dependencyPath = decodeURIComponent(dependency.pathname.slice(1));
      if (dependencyPath === changedPath) return true;
      const dir = getParentDirectory(dependencyPath);
      if (dir !== '.' && isSameOrDescendantPath(changedPath, dir)) return true;
    } catch { /* Ignore malformed references. */ }
  }
  return false;
}


export function previewDependencyDirectories(path: string, content: string): string[] {
  if (!['html', 'htm', 'md', 'markdown', 'mdx'].includes(getExtension(path))) return [];
  const base = new URL(path, 'https://workspace.invalid/');
  const dirs = new Set<string>();
  for (const match of content.matchAll(/(?:src|href)=["']([^"']+)["']|\]\(([^)\s]+)\)/gi)) {
    try {
      const dependency = new URL(match[1] ?? match[2], base);
      if (dependency.origin !== base.origin) continue;
      const resourcePath = decodeURIComponent(dependency.pathname.slice(1));
      if (ASSETS.has(getExtension(resourcePath))) dirs.add(getParentDirectory(resourcePath));
    } catch { /* Ignore malformed references. */ }
  }
  return [...dirs].slice(0, 64);
}
