import { INTERNAL_WORKSPACE_STAGING_SUFFIX } from '../files/internal-staging-path';

// Both the filesystem walker and the catalogue queries use these patterns.
// Directories are tested with a trailing slash, including inferred parents of
// registry-only documents. The skill draft directory is root-relative.
export const WORKSPACE_LINK_SOURCE_PATH_EXCLUSIONS = [
  String.raw`^\.canvas-skill-drafts/|(^|/)(node_modules|\.next|\.git|dist|build|\.cache|\.canvas-brand|\.canvas-copy-backups)/|(^|/)\.(gitkeep|keep)(/|$)`,
  `${INTERNAL_WORKSPACE_STAGING_SUFFIX}(/|$)`,
] as const;
const excludedPath = new RegExp(WORKSPACE_LINK_SOURCE_PATH_EXCLUSIONS[0]);
const stagingPath = new RegExp(WORKSPACE_LINK_SOURCE_PATH_EXCLUSIONS[1], 'i');

export function workspaceLinkSourceVisibleSql(column: 'path' | 's.path' | 'd.path', firstParameter: number): string {
  return `${column} !~ $${firstParameter} AND ${column} !~* $${firstParameter + 1}`;
}

export function isExcludedWorkspaceLinkSourcePath(relativePath: string, directory: boolean): boolean {
  const candidate = directory ? `${relativePath}/` : relativePath;
  return excludedPath.test(candidate) || stagingPath.test(candidate);
}
