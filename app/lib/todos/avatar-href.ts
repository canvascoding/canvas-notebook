import 'server-only';

/** The account avatar endpoint always serves the viewer, so it must be scoped before displaying another user. */
export function isCurrentAccountAvatarHref(image: string | null | undefined): boolean {
  return typeof image === 'string' && /^\/api\/account\/profile\/avatar(?:\?|$)/u.test(image);
}

export function todoUserAvatarHref(todoId: string, userId: string, image: string | null | undefined): string | null {
  if (!image) return null;
  if (!isCurrentAccountAvatarHref(image)) return image;
  const revision = new URL(image, 'http://canvas.local').searchParams.get('v');
  const params = new URLSearchParams({ userId });
  if (revision) params.set('v', revision);
  return `/api/todos/${encodeURIComponent(todoId)}/avatar?${params}`;
}

/** Candidate lists have no Todo authorization scope; avoid displaying the viewer's avatar as somebody else. */
export function assigneeCandidateAvatarHref(candidateId: string, viewerId: string, image: string | null | undefined): string | null {
  return candidateId !== viewerId && isCurrentAccountAvatarHref(image) ? null : image || null;
}
