export type TeamSeatHealthState = 'healthy' | 'stale' | 'attention' | 'never';

export type TeamSeatHealth = {
  organizationId: string;
  generatedAt: string;
  claim: {
    state: 'idle' | 'canceled' | 'authorization_pending' | 'connected' | 'reconnect_required';
    connectionExpiresAt: string | null;
    reconnectReason: string | null;
  };
  sync: {
    state: TeamSeatHealthState;
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
