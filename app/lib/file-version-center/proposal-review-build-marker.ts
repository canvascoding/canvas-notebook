import 'server-only';

import packageJson from '../../../package.json';

/** Public build metadata only: never reflect arbitrary environment strings. */
export function proposalReviewBuildMarker(): string {
  const explicit = process.env.FVRC_BUILD_MARKER ?? process.env.NEXT_DEPLOYMENT_ID;
  if (explicit && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(explicit)) return explicit;
  const commit = process.env.RELEASE_COMMIT_SHA;
  const suffix = commit && /^[a-f0-9]{40}$/.test(commit) ? commit.slice(0, 12)
    : process.env.NODE_ENV === 'production' ? 'release' : 'dev';
  return `canvas-${packageJson.version}-${suffix}`;
}
