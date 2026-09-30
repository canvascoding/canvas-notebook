export type TeamSeatHealthState = 'healthy' | 'stale' | 'attention' | 'never';

export type TeamSeatHealth = {
  mode?: 'community' | 'managed-team';
  managedAccessPolicy?: {
    state: 'active' | 'grace' | 'restricted';
    reason: 'grant_expired' | 'grant_revoked' | null;
    graceEndsAt: string | null;
  } | null;
  historicalCommunity?: { pendingOperations: number; failedOperations: number };
  organizationId: string;
  generatedAt: string;
  emailDelivery?: {
    manualReview: number;
    retryPending: number;
  };
  license: {
    class: 'commercial' | 'manual' | 'test' | null;
    environment: 'development' | 'test' | 'staging' | 'production' | null;
    seatLimit: number | null;
    expiresAt: string | null;
    termEndsAt?: string | null;
    nonBillable: boolean;
    billingMode: 'commercial' | 'manual_grant' | 'test_grant' | 'unlicensed';
  };
  claim: {
    state: 'idle' | 'canceled' | 'authorization_pending' | 'connected' | 'reconnect_required';
    connectionExpiresAt: string | null;
    reconnectReason: string | null;
  };
  sync: {
    state: TeamSeatHealthState;
    managedState?: 'current' | 'adoption_required' | 'pending' | 'error' | 'stale' | 'never' | null;
    lastAttemptAt?: string | null;
    lastError?: { code: string; endpoint: string | null; httpStatus: number | null } | null;
    membershipRevision?: number | null;
    entitlementsVersion?: number | null;
    blocker: 'TEAM_SEAT_SUBJECT_CONFLICT' | null;
    observedQuantity: number | null;
    approvedQuantity: number | null;
    billedQuantity: number | null;
    licensedQuantity: number | null;
    lastSyncAt: string | null;
    nextReportAt: string | null;
    staleAfterAt: string | null;
    driftStatus: string | null;
    reconciliationStatus: string | null;
    reconciliationAction: string | null;
    reconciliationReason: string | null;
    reconciliationSeatLimit: number | null;
    supportRequired: boolean;
    pendingOperations: number;
    failedOperations: number;
    oldestPendingAt: string | null;
  };
  grace: {
    licenseState: string;
    startedAt: string | null;
    expiresAt: string | null;
    remainingSeconds: number | null;
    refreshPhase: string | null;
    nextRefreshAt: string | null;
    lastRefreshErrorCode: string | null;
  };
  recovery: {
    canSyncSnapshot: boolean;
    canRefreshLicense: boolean;
    reconnectRequired: boolean;
    costConfirmationRequired: false;
  };
};
