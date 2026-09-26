import 'server-only';

/** Production rollout stays closed until FVRC-1008. Local tests exercise the real authorized HTTP path. */
export function proposalReviewWritesEnabled(): boolean {
  return (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
    && process.env.CANVAS_PROPOSAL_REVIEW_LOCAL_TEST === '1';
}
