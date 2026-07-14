import path from 'node:path';

import { requirePathInside } from '@/app/lib/security/safe-paths';

export type PiOAuthFlowPaths = {
  stateFile: string;
  codeFile: string;
  tempScriptDir: string;
  tempAuthPath: string;
};

export function normalizeOAuthFlowId(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,128}$/u.test(trimmed) ? trimmed : null;
}

export function resolvePiOAuthFlowPaths(oauthStateDir: string, flowId: string): PiOAuthFlowPaths {
  const normalizedFlowId = normalizeOAuthFlowId(flowId);
  if (!normalizedFlowId) {
    throw new Error('Invalid OAuth flow id.');
  }
  const root = path.resolve(oauthStateDir);
  const tempDirectoryName = normalizedFlowId + '_oauth';

  return {
    stateFile: requirePathInside(root, normalizedFlowId + '.json'),
    codeFile: requirePathInside(root, normalizedFlowId + '_code.txt'),
    tempScriptDir: requirePathInside(root, tempDirectoryName),
    tempAuthPath: requirePathInside(root, tempDirectoryName, 'credentials.json'),
  };
}
