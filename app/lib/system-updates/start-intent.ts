import type { StartSystemUpdateInput } from './types';

export function restoreUpdateStartIntent(value: string | null): StartSystemUpdateInput | null {
  if (!value) return null;
  try {
    const input = JSON.parse(value) as Partial<StartSystemUpdateInput> | null;
    if (!input || !['stable', 'beta'].includes(String(input.channel)) ||
      typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.requestId) ||
      typeof input.expectedReleaseId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(input.expectedReleaseId)) return null;
    return { channel: input.channel as 'stable' | 'beta', requestId: input.requestId.toLowerCase(), expectedReleaseId: input.expectedReleaseId };
  } catch { return null; }
}
