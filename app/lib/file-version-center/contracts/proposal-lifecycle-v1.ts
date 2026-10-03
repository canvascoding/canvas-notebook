/** Portable lifecycle vocabulary shared by browser and mobile operation DTOs. */
export const PROPOSAL_LIFECYCLE_V1 = Object.freeze({
  open: 'open',
  applied: 'applied',
  included: 'included',
  rejected: 'rejected',
  superseded: 'superseded',
  alternativeNotSelected: 'alternative_not_selected',
  satisfiedElsewhere: 'satisfied_elsewhere',
  expired: 'expired',
} as const);

export type ProposalLifecycleV1 = typeof PROPOSAL_LIFECYCLE_V1[keyof typeof PROPOSAL_LIFECYCLE_V1];
