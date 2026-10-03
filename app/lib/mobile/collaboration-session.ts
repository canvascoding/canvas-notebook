import type { CollaborationSessionGrant } from '../collaboration/session-service';

type ProjectionGrant = Pick<CollaborationSessionGrant,
  'documentSequence' | 'degraded' | 'projectionError' | 'projectionFinalized'>;

/** Forward authoritative status without certifying a projection from sequence equality. */
export function mobileCollaborationProjectionStatus(grant: ProjectionGrant) {
  if ((grant.degraded !== undefined && typeof grant.degraded !== 'boolean')
    || (grant.projectionFinalized !== undefined && typeof grant.projectionFinalized !== 'boolean')) {
    throw new Error('The collaboration projection status is invalid.');
  }
  const error = grant.projectionError;
  if (error !== undefined && (!error || typeof error !== 'object' || Array.isArray(error)
    || typeof error.code !== 'string' || typeof error.permanent !== 'boolean'
    || !Number.isSafeInteger(error.sequence) || error.sequence < 0
    || !Number.isSafeInteger(grant.documentSequence) || error.sequence > grant.documentSequence!
    || (error.phase !== undefined && typeof error.phase !== 'string'))) {
    throw new Error('The collaboration projection status is invalid.');
  }
  return {
    ...(grant.degraded !== undefined ? { degraded: grant.degraded } : {}),
    ...(grant.projectionFinalized !== undefined ? { projectionFinalized: grant.projectionFinalized } : {}),
    ...(error !== undefined ? { projectionError: {
      code: error.code, sequence: error.sequence, permanent: error.permanent,
      ...(error.phase !== undefined ? { phase: error.phase } : {}),
    } } : {}),
  };
}
