import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

export type WorkspaceMentionCandidate = {
  detail: string | null;
  label: string;
  userId: string;
};

type MentionCandidateResponse = {
  candidates?: unknown;
  error?: unknown;
  success?: unknown;
};

const mentionCandidateCache = new Map<string, Promise<WorkspaceMentionCandidate[]>>();

function normalizeCandidate(value: unknown): WorkspaceMentionCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const userId = typeof candidate.userId === 'string' ? candidate.userId.trim() : '';
  const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
  if (!userId || !label) return null;
  return {
    detail: typeof candidate.detail === 'string' && candidate.detail.trim()
      ? candidate.detail.trim()
      : null,
    label,
    userId,
  };
}

export async function loadWorkspaceMentionCandidates(
  workspaceId: string,
): Promise<WorkspaceMentionCandidate[]> {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) return [];

  const cached = mentionCandidateCache.get(normalizedWorkspaceId);
  if (cached) return cached;

  const request = fetch(
    `/api/workspaces/${encodeURIComponent(normalizedWorkspaceId)}/mention-candidates`,
    {
      cache: 'no-store',
      credentials: 'include',
      headers: { [WORKSPACE_ID_HEADER]: normalizedWorkspaceId },
    },
  ).then(async (response) => {
    const payload = await response.json().catch(() => null) as MentionCandidateResponse | null;
    if (!response.ok || payload?.success !== true) {
      throw new Error(
        typeof payload?.error === 'string'
          ? payload.error
          : 'Mention candidates could not be loaded.',
      );
    }
    const candidates = Array.isArray(payload.candidates)
      ? payload.candidates.map(normalizeCandidate).filter((item): item is WorkspaceMentionCandidate => Boolean(item))
      : [];
    return candidates;
  }).catch((error) => {
    mentionCandidateCache.delete(normalizedWorkspaceId);
    throw error;
  });

  mentionCandidateCache.set(normalizedWorkspaceId, request);
  return request;
}

export function filterWorkspaceMentionCandidates(
  candidates: WorkspaceMentionCandidate[],
  query: string,
  limit = 20,
): WorkspaceMentionCandidate[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return candidates
    .filter((candidate) => !normalizedQuery || [
      candidate.label,
      candidate.detail ?? '',
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
    .slice(0, Math.max(0, limit));
}

export function clearWorkspaceMentionCandidateCache(workspaceId?: string): void {
  if (workspaceId) {
    mentionCandidateCache.delete(workspaceId.trim());
    return;
  }
  mentionCandidateCache.clear();
}
