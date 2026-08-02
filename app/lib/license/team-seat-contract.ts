export const TEAM_SEAT_PROTOCOL_VERSION = 'canvas-team-seat-protocol-v1' as const;

export const TEAM_SEAT_HOSTING_MODES = ['community', 'cloud'] as const;
export const TEAM_SEAT_EDITIONS = ['solo', 'team'] as const;
export const TEAM_SEAT_LICENSE_CLASSES = ['commercial', 'manual', 'test'] as const;
export const TEAM_SEAT_LICENSE_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export const TEAM_SEAT_BILLING_PROVIDERS = ['stripe', 'manual', 'test', 'disabled'] as const;
export const TEAM_SEAT_INSTANCE_TOKEN_SCOPES = [
  'license:refresh',
  'license:verify',
  'seat:prepare',
  'seat:execute',
  'seat:snapshot',
  'token:rotate',
] as const;
export const TEAM_SEAT_CHANGE_TYPES = [
  'team_upgrade',
  'member_create',
  'invitation_accept',
  'member_remove',
  'reconcile',
] as const;
export const TEAM_SEAT_OPERATION_STATUSES = [
  'pending',
  'requires_action',
  'applied',
  'failed',
  'canceled',
  'reconciling',
] as const;
export const TEAM_SEAT_DRIFT_STATUSES = [
  'pending',
  'in_sync',
  'observed_below_approved',
  'observed_above_approved',
  'licensed_above_approved',
  'licensed_below_approved',
  'stale',
  'error',
] as const;
export const TEAM_SEAT_AUTHORIZATION_STATUSES = [
  'pending',
  'approved',
  'consumed',
  'expired',
  'revoked',
] as const;

export type TeamSeatHostingMode = typeof TEAM_SEAT_HOSTING_MODES[number];
export type TeamSeatEdition = typeof TEAM_SEAT_EDITIONS[number];
export type TeamSeatLicenseClass = typeof TEAM_SEAT_LICENSE_CLASSES[number];
export type TeamSeatLicenseEnvironment = typeof TEAM_SEAT_LICENSE_ENVIRONMENTS[number];
export type TeamSeatBillingProviderName = typeof TEAM_SEAT_BILLING_PROVIDERS[number];
export type TeamSeatInstanceTokenScope = typeof TEAM_SEAT_INSTANCE_TOKEN_SCOPES[number];
export type TeamSeatChangeType = typeof TEAM_SEAT_CHANGE_TYPES[number];
export type TeamSeatOperationStatus = typeof TEAM_SEAT_OPERATION_STATUSES[number];
export type TeamSeatDriftStatus = typeof TEAM_SEAT_DRIFT_STATUSES[number];
export type TeamSeatAuthorizationStatus = typeof TEAM_SEAT_AUTHORIZATION_STATUSES[number];

export type TeamSeatSubject =
  | { type: 'organization'; organizationId: string }
  | { type: 'license'; licenseId: string };

export const TEAM_SEAT_ERROR_CODES = {
  invalidRequest: 'TEAM_SEAT_INVALID_REQUEST',
  protocolUnsupported: 'TEAM_SEAT_PROTOCOL_UNSUPPORTED',
  featureDisabled: 'TEAM_SEAT_FEATURE_DISABLED',
  adminNotAllowed: 'TEAM_SEAT_ADMIN_NOT_ALLOWED',
  environmentNotAllowed: 'TEAM_SEAT_ENVIRONMENT_NOT_ALLOWED',
  testInProduction: 'TEAM_SEAT_TEST_IN_PRODUCTION',
  signingIsolationInvalid: 'TEAM_SEAT_SIGNING_ISOLATION_INVALID',
  subjectNotFound: 'TEAM_SEAT_SUBJECT_NOT_FOUND',
  subjectConflict: 'TEAM_SEAT_SUBJECT_CONFLICT',
  instanceMismatch: 'TEAM_SEAT_INSTANCE_MISMATCH',
  grantNotFound: 'TEAM_SEAT_GRANT_NOT_FOUND',
  grantConflict: 'TEAM_SEAT_GRANT_CONFLICT',
  grantExpired: 'TEAM_SEAT_GRANT_EXPIRED',
  grantRevoked: 'TEAM_SEAT_GRANT_REVOKED',
  seatLimitExceeded: 'TEAM_SEAT_LIMIT_EXCEEDED',
  ttlExceeded: 'TEAM_SEAT_TTL_EXCEEDED',
  externalReferenceRequired: 'TEAM_SEAT_EXTERNAL_REFERENCE_REQUIRED',
  tokenInvalid: 'TEAM_SEAT_TOKEN_INVALID',
  tokenScopeDenied: 'TEAM_SEAT_TOKEN_SCOPE_DENIED',
  tokenInstanceMismatch: 'TEAM_SEAT_TOKEN_INSTANCE_MISMATCH',
  accountRequired: 'TEAM_SEAT_ACCOUNT_REQUIRED',
  billingOrganizationRequired: 'TEAM_SEAT_BILLING_ORGANIZATION_REQUIRED',
  postgresRequired: 'TEAM_SEAT_POSTGRES_REQUIRED',
  runtimeNotReady: 'TEAM_SEAT_RUNTIME_NOT_READY',
  notebookUpdateRequired: 'TEAM_SEAT_NOTEBOOK_UPDATE_REQUIRED',
  claimExpired: 'TEAM_SEAT_CLAIM_EXPIRED',
  claimConflict: 'TEAM_SEAT_CLAIM_CONFLICT',
  claimReplay: 'TEAM_SEAT_CLAIM_REPLAY',
  quoteStale: 'TEAM_SEAT_QUOTE_STALE',
  authorizationRequired: 'TEAM_SEAT_AUTHORIZATION_REQUIRED',
  authorizationExpired: 'TEAM_SEAT_AUTHORIZATION_EXPIRED',
  authorizationReplay: 'TEAM_SEAT_AUTHORIZATION_REPLAY',
  idempotencyConflict: 'TEAM_SEAT_IDEMPOTENCY_CONFLICT',
  paymentRequiresAction: 'TEAM_SEAT_PAYMENT_REQUIRES_ACTION',
  paymentFailed: 'TEAM_SEAT_PAYMENT_FAILED',
  billingPastDue: 'TEAM_SEAT_BILLING_PAST_DUE',
  billingCanceled: 'TEAM_SEAT_BILLING_CANCELED',
  reconciliationRequired: 'TEAM_SEAT_RECONCILIATION_REQUIRED',
  temporaryUnavailable: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
} as const;

export type TeamSeatErrorCode = typeof TEAM_SEAT_ERROR_CODES[keyof typeof TEAM_SEAT_ERROR_CODES];

export type TeamSeatErrorPayload = {
  error: string;
  code: TeamSeatErrorCode;
  retryable: boolean;
};

export type TeamSeatEntitlements = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  subject: TeamSeatSubject;
  hostingMode: TeamSeatHostingMode;
  edition: TeamSeatEdition;
  licenseClass: TeamSeatLicenseClass;
  licenseEnvironment: TeamSeatLicenseEnvironment;
  provider: TeamSeatBillingProviderName;
  teamEnabled: boolean;
  observedSeats: number;
  approvedSeats: number;
  billedSeats: number;
  licensedSeats: number;
  entitlementsVersion: number;
  expiresAt: string | null;
  nonBillable: boolean;
};

export type TeamSeatQuote = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  quoteId: string;
  subject: TeamSeatSubject;
  provider?: Exclude<TeamSeatBillingProviderName, 'disabled'>;
  environment?: TeamSeatLicenseEnvironment;
  quantityBefore: number;
  quantityAfter: number;
  quantityDelta: number;
  unitAmountCents: number;
  currency: string;
  billingInterval: 'month';
  immediateAmountCents: number | null;
  recurringAmountCents: number;
  status?: 'active' | 'consumed' | 'expired' | 'revoked';
  expiresAt: string;
  quoteHash: string;
  nonBillable?: boolean;
};

export type TeamSeatChangeAuthorization = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  authorizationId: string;
  quoteId?: string;
  quoteHash: string;
  quantityBefore: number;
  quantityAfter: number;
  status: TeamSeatAuthorizationStatus;
  expiresAt: string;
  approvedAt?: string | null;
  consumedAt?: string | null;
};

export type TeamSeatMembershipSnapshot = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  revision: number;
  snapshotHash: string;
  observedQuantity: number;
  roleSummary: Record<string, number>;
  memberHashes: string[];
  generatedAt: string;
  notebookVersion?: string | null;
};

export type TeamSeatLicenseClaims = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  licenseId: string;
  instanceId: string;
  hostingMode: TeamSeatHostingMode;
  edition: TeamSeatEdition;
  licenseClass: TeamSeatLicenseClass;
  licenseEnvironment: TeamSeatLicenseEnvironment;
  provider: TeamSeatBillingProviderName;
  seatLimit: number;
  entitlementsVersion: number;
  grantId?: string;
  nonBillable: boolean;
};

export type TeamSeatCommunityPreflightRequest = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  notebookVersion: string;
  databaseEngine: 'postgres' | 'sqlite' | 'other';
  teamReady: boolean;
};

export type TeamSeatCommunityPreflightResponse = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  ready: boolean;
  mutating: false;
  nextAction: 'resolve_blockers' | 'manage_seats' | 'start_checkout';
  license: {
    licenseId: string;
    instanceId: string;
    hostingMode: 'community';
    edition: TeamSeatEdition;
    licenseClass: TeamSeatLicenseClass;
    licenseEnvironment: TeamSeatLicenseEnvironment;
    claimed: boolean;
    billingOrganizationId: string | null;
  };
  runtime: {
    notebookVersion: string;
    minimumNotebookVersion: string | null;
    versionSupported: boolean;
    databaseEngine: 'postgres' | 'sqlite' | 'other';
    teamReady: boolean;
  };
  team: {
    active: boolean;
    provider: Exclude<TeamSeatBillingProviderName, 'disabled'> | null;
    billingStatus: string | null;
    observedQuantity: number;
    approvedQuantity: number;
    billedQuantity: number;
    licensedQuantity: number;
    entitlementsVersion: number;
    nonBillable: boolean;
  };
  rollout: {
    communityCommercial: {
      requested: boolean;
      effective: boolean;
    };
    cloudCommercial: {
      requested: boolean;
      effective: boolean;
    };
    stripeMutations: {
      requested: boolean;
      effective: boolean;
      implementationReady: boolean;
      billingMode: string;
      credentialsConfigured: boolean;
      prorationPolicy: string | null;
      prorationPolicyConfigured: boolean;
    };
  };
  blockers: Array<{
    code: TeamSeatErrorCode;
    message: string;
  }>;
};

export type TeamSeatClaimStartRequest = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  licenseCertificate: string;
  instanceId: string;
};

export type TeamSeatClaimStart = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  pollIntervalSeconds: number;
};

export type TeamSeatClaimPollRequest = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  deviceCode: string;
};

export type TeamSeatClaimPollResult =
  | {
      protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
      status: 'authorization_pending';
      pollIntervalSeconds: number;
      expiresAt: string;
    }
  | {
      protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
      status: 'approved';
      instanceToken: string;
      tokenType: 'Bearer';
      scopes: TeamSeatInstanceTokenScope[];
      expiresAt: string | null;
      organizationId: string;
      instanceId: string;
    };

export type TeamSeatTokenLifecycleRequest = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
};

export type TeamSeatTokenRotation = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  instanceToken: string;
  tokenType: 'Bearer';
  scopes: TeamSeatInstanceTokenScope[];
  expiresAt: string | null;
  instanceId: string;
};

export type TeamSeatPrepareRequest = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  desiredQuantity: number;
  triggerType: TeamSeatChangeType;
  externalReference?: string | null;
};

export type TeamSeatChangeSnapshotState = {
  revision: number;
  observedQuantity: number;
  licensedQuantity: number;
  approvedQuantity: number;
  billedQuantity: number;
  billingStatus: string;
};

export type TeamSeatPrepareResponse = {
  quote: TeamSeatQuote;
  authorization: TeamSeatChangeAuthorization;
  requiresBillingApproval: boolean;
  snapshot: TeamSeatChangeSnapshotState;
};

export type TeamSeatExecuteRequest = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  authorizationId: string;
  operationKey: string;
  operationType: TeamSeatChangeType;
};

export type TeamSeatOperation = {
  protocolVersion: typeof TEAM_SEAT_PROTOCOL_VERSION;
  operationId: string;
  operationKey: string;
  operationType: TeamSeatChangeType;
  provider: Exclude<TeamSeatBillingProviderName, 'disabled'>;
  environment: TeamSeatLicenseEnvironment;
  status: TeamSeatOperationStatus;
  paymentStatus: string | null;
  previousQuantity: number;
  requestedQuantity: number;
  effectiveQuantity: number | null;
  retryCount: number;
  lastError: string | null;
  effectiveAt: string | null;
  entitlementsVersion: number | null;
  certificateReissueStatus: 'pending' | 'issued' | 'failed';
  createdAt: string;
  updatedAt: string;
};

export type TeamSeatLicenseRefresh = {
  license: string;
  details: {
    id: string;
    plan: string;
    status: string;
    instanceId: string;
    hostingMode: TeamSeatHostingMode;
    edition: TeamSeatEdition;
    licenseClass: TeamSeatLicenseClass;
    licenseEnvironment: TeamSeatLicenseEnvironment;
    billingOrganizationId: string | null;
    entitlementsVersion: number;
    deploymentMode: string;
    features: Record<string, boolean>;
    quotas: Record<string, number>;
    activatedAt: string | null;
    expiresAt: string | null;
  };
};

export type TeamSeatExecuteResponse = {
  operation: TeamSeatOperation;
  replayed: boolean;
  license: TeamSeatLicenseRefresh | null;
};

export type TeamSeatSnapshotRequest = TeamSeatMembershipSnapshot;

export type TeamSeatSnapshotRecord = TeamSeatMembershipSnapshot & {
  snapshotId: string;
  receivedAt: string;
  reconciledAt: string | null;
  driftStatus: TeamSeatDriftStatus;
};

export type TeamSeatSnapshotResponse = {
  snapshot: TeamSeatSnapshotRecord;
  observedQuantity: number;
  billedQuantity: number;
  licensedQuantity: number;
  expectedLicensedQuantity: number;
  approvedQuantity: number;
  billingStatus: string;
  nextReportAt: string;
  replayed: boolean;
};

export class TeamSeatContractError extends Error {
  constructor(
    public readonly code: typeof TEAM_SEAT_ERROR_CODES.invalidRequest | typeof TEAM_SEAT_ERROR_CODES.protocolUnsupported,
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'TeamSeatContractError';
  }
}

type JsonRecord = Record<string, unknown>;

function invalid(path: string, message: string): never {
  throw new TeamSeatContractError(TEAM_SEAT_ERROR_CODES.invalidRequest, message, path);
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(path, `${path} must be an object.`);
  }
  return value as JsonRecord;
}

function stringValue(value: unknown, path: string, options?: { min?: number; max?: number; pattern?: RegExp }): string {
  if (typeof value !== 'string') return invalid(path, `${path} must be a string.`);
  const min = options?.min ?? 1;
  const max = options?.max ?? 32_768;
  if (value.length < min || value.length > max) {
    return invalid(path, `${path} must contain between ${min} and ${max} characters.`);
  }
  if (options?.pattern && !options.pattern.test(value)) {
    return invalid(path, `${path} has an invalid format.`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringValue(value, path);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return invalid(path, `${path} must be a boolean.`);
  return value;
}

function integerValue(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return invalid(path, `${path} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function nullableInteger(value: unknown, path: string, minimum = 0): number | null {
  if (value === null) return null;
  return integerValue(value, path, minimum);
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    return invalid(path, `${path} must be one of: ${values.join(', ')}.`);
  }
  return value as Values[number];
}

function isoTimestamp(value: unknown, path: string): string {
  const timestamp = stringValue(value, path);
  if (Number.isNaN(Date.parse(timestamp))) return invalid(path, `${path} must be an ISO timestamp.`);
  return timestamp;
}

function nullableTimestamp(value: unknown, path: string): string | null {
  if (value === null) return null;
  return isoTimestamp(value, path);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return invalid(path, `${path} must be an array.`);
  return value.map((entry, index) => stringValue(entry, `${path}[${index}]`));
}

function booleanRecord(value: unknown, path: string): Record<string, boolean> {
  const input = record(value, path);
  return Object.fromEntries(
    Object.entries(input).map(([key, entry]) => [key, booleanValue(entry, `${path}.${key}`)]),
  );
}

function numberRecord(value: unknown, path: string): Record<string, number> {
  const input = record(value, path);
  return Object.fromEntries(
    Object.entries(input).map(([key, entry]) => [key, integerValue(entry, `${path}.${key}`)]),
  );
}

function optionalEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] | undefined {
  if (value === undefined) return undefined;
  return enumValue(value, values, path);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  return booleanValue(value, path);
}

function assertEnvironmentIsolation(input: {
  licenseClass?: TeamSeatLicenseClass;
  provider?: TeamSeatBillingProviderName;
  environment: TeamSeatLicenseEnvironment;
}, path: string): void {
  if (
    input.environment === 'production'
    && (input.licenseClass === 'test' || input.provider === 'test')
  ) {
    invalid(path, 'Test licenses and providers are not valid in production.');
  }
}

export function assertTeamSeatProtocolVersion(value: unknown, path = 'protocolVersion'): asserts value is typeof TEAM_SEAT_PROTOCOL_VERSION {
  if (value !== TEAM_SEAT_PROTOCOL_VERSION) {
    throw new TeamSeatContractError(
      TEAM_SEAT_ERROR_CODES.protocolUnsupported,
      `Unsupported Team Seat protocol version: ${String(value)}`,
      path,
    );
  }
}

function protocolRecord(value: unknown, path: string): JsonRecord {
  const input = record(value, path);
  assertTeamSeatProtocolVersion(input.protocolVersion, `${path}.protocolVersion`);
  return input;
}

export function parseTeamSeatLicenseClass(value: unknown, path = 'licenseClass'): TeamSeatLicenseClass {
  return enumValue(value, TEAM_SEAT_LICENSE_CLASSES, path);
}

export function parseTeamSeatLicenseEnvironment(value: unknown, path = 'licenseEnvironment'): TeamSeatLicenseEnvironment {
  return enumValue(value, TEAM_SEAT_LICENSE_ENVIRONMENTS, path);
}

export function parseTeamSeatDriftStatus(value: unknown, path = 'driftStatus'): TeamSeatDriftStatus {
  return enumValue(value, TEAM_SEAT_DRIFT_STATUSES, path);
}

export function parseTeamSeatSubject(value: unknown, path = 'subject'): TeamSeatSubject {
  const input = record(value, path);
  if (input.type === 'license') {
    return { type: 'license', licenseId: stringValue(input.licenseId, `${path}.licenseId`) };
  }
  if (input.type === 'organization') {
    return { type: 'organization', organizationId: stringValue(input.organizationId, `${path}.organizationId`) };
  }
  return invalid(`${path}.type`, `${path}.type must be license or organization.`);
}

export function parseTeamSeatErrorPayload(value: unknown, path = 'error'): TeamSeatErrorPayload {
  const input = record(value, path);
  return {
    error: stringValue(input.error, `${path}.error`),
    code: enumValue(input.code, Object.values(TEAM_SEAT_ERROR_CODES), `${path}.code`),
    retryable: booleanValue(input.retryable, `${path}.retryable`),
  };
}

export function parseTeamSeatEntitlements(value: unknown, path = 'entitlements'): TeamSeatEntitlements {
  const input = protocolRecord(value, path);
  const licenseClass = parseTeamSeatLicenseClass(input.licenseClass, `${path}.licenseClass`);
  const licenseEnvironment = parseTeamSeatLicenseEnvironment(input.licenseEnvironment, `${path}.licenseEnvironment`);
  const provider = enumValue(input.provider, TEAM_SEAT_BILLING_PROVIDERS, `${path}.provider`);
  assertEnvironmentIsolation({ licenseClass, provider, environment: licenseEnvironment }, path);
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    subject: parseTeamSeatSubject(input.subject, `${path}.subject`),
    hostingMode: enumValue(input.hostingMode, TEAM_SEAT_HOSTING_MODES, `${path}.hostingMode`),
    edition: enumValue(input.edition, TEAM_SEAT_EDITIONS, `${path}.edition`),
    licenseClass,
    licenseEnvironment,
    provider,
    teamEnabled: booleanValue(input.teamEnabled, `${path}.teamEnabled`),
    observedSeats: integerValue(input.observedSeats, `${path}.observedSeats`),
    approvedSeats: integerValue(input.approvedSeats, `${path}.approvedSeats`),
    billedSeats: integerValue(input.billedSeats, `${path}.billedSeats`),
    licensedSeats: integerValue(input.licensedSeats, `${path}.licensedSeats`),
    entitlementsVersion: integerValue(input.entitlementsVersion, `${path}.entitlementsVersion`),
    expiresAt: nullableTimestamp(input.expiresAt, `${path}.expiresAt`),
    nonBillable: booleanValue(input.nonBillable, `${path}.nonBillable`),
  };
}

export function parseTeamSeatQuote(value: unknown, path = 'quote'): TeamSeatQuote {
  const input = protocolRecord(value, path);
  const provider = optionalEnum(input.provider, ['stripe', 'manual', 'test'] as const, `${path}.provider`);
  const environment = optionalEnum(input.environment, TEAM_SEAT_LICENSE_ENVIRONMENTS, `${path}.environment`);
  if (provider && environment) assertEnvironmentIsolation({ provider, environment }, path);
  const quantityBefore = integerValue(input.quantityBefore, `${path}.quantityBefore`);
  const quantityAfter = integerValue(input.quantityAfter, `${path}.quantityAfter`);
  const quantityDelta = integerValue(
    input.quantityDelta,
    `${path}.quantityDelta`,
    -Number.MAX_SAFE_INTEGER,
  );
  if (quantityAfter - quantityBefore !== quantityDelta) {
    invalid(`${path}.quantityDelta`, 'Seat quote quantityDelta does not match quantityBefore and quantityAfter.');
  }
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    quoteId: stringValue(input.quoteId, `${path}.quoteId`),
    subject: parseTeamSeatSubject(input.subject, `${path}.subject`),
    provider,
    environment,
    quantityBefore,
    quantityAfter,
    quantityDelta,
    unitAmountCents: integerValue(input.unitAmountCents, `${path}.unitAmountCents`),
    currency: stringValue(input.currency, `${path}.currency`, { pattern: /^[a-z]{3}$/u }),
    billingInterval: enumValue(input.billingInterval, ['month'] as const, `${path}.billingInterval`),
    immediateAmountCents: nullableInteger(input.immediateAmountCents, `${path}.immediateAmountCents`),
    recurringAmountCents: integerValue(input.recurringAmountCents, `${path}.recurringAmountCents`),
    status: optionalEnum(input.status, ['active', 'consumed', 'expired', 'revoked'] as const, `${path}.status`),
    expiresAt: isoTimestamp(input.expiresAt, `${path}.expiresAt`),
    quoteHash: stringValue(input.quoteHash, `${path}.quoteHash`),
    nonBillable: optionalBoolean(input.nonBillable, `${path}.nonBillable`),
  };
}

export function parseTeamSeatAuthorization(value: unknown, path = 'authorization'): TeamSeatChangeAuthorization {
  const input = protocolRecord(value, path);
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    authorizationId: stringValue(input.authorizationId, `${path}.authorizationId`),
    quoteId: input.quoteId === undefined ? undefined : stringValue(input.quoteId, `${path}.quoteId`),
    quoteHash: stringValue(input.quoteHash, `${path}.quoteHash`),
    quantityBefore: integerValue(input.quantityBefore, `${path}.quantityBefore`),
    quantityAfter: integerValue(input.quantityAfter, `${path}.quantityAfter`),
    status: enumValue(input.status, TEAM_SEAT_AUTHORIZATION_STATUSES, `${path}.status`),
    expiresAt: isoTimestamp(input.expiresAt, `${path}.expiresAt`),
    approvedAt: input.approvedAt === undefined ? undefined : nullableTimestamp(input.approvedAt, `${path}.approvedAt`),
    consumedAt: input.consumedAt === undefined ? undefined : nullableTimestamp(input.consumedAt, `${path}.consumedAt`),
  };
}

export function parseTeamSeatMembershipSnapshot(value: unknown, path = 'snapshot'): TeamSeatMembershipSnapshot {
  const input = protocolRecord(value, path);
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    revision: integerValue(input.revision, `${path}.revision`),
    snapshotHash: stringValue(input.snapshotHash, `${path}.snapshotHash`),
    observedQuantity: integerValue(input.observedQuantity, `${path}.observedQuantity`),
    roleSummary: numberRecord(input.roleSummary, `${path}.roleSummary`),
    memberHashes: stringArray(input.memberHashes, `${path}.memberHashes`),
    generatedAt: isoTimestamp(input.generatedAt, `${path}.generatedAt`),
    notebookVersion: input.notebookVersion === undefined
      ? undefined
      : input.notebookVersion === null
        ? null
        : stringValue(input.notebookVersion, `${path}.notebookVersion`, { max: 64 }),
  };
}

export function parseTeamSeatLicenseClaims(value: unknown, path = 'claims'): TeamSeatLicenseClaims {
  const input = protocolRecord(value, path);
  const licenseClass = parseTeamSeatLicenseClass(input.licenseClass, `${path}.licenseClass`);
  const licenseEnvironment = parseTeamSeatLicenseEnvironment(input.licenseEnvironment, `${path}.licenseEnvironment`);
  const provider = enumValue(input.provider, TEAM_SEAT_BILLING_PROVIDERS, `${path}.provider`);
  assertEnvironmentIsolation({ licenseClass, provider, environment: licenseEnvironment }, path);
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    licenseId: stringValue(input.licenseId, `${path}.licenseId`),
    instanceId: stringValue(input.instanceId, `${path}.instanceId`),
    hostingMode: enumValue(input.hostingMode, TEAM_SEAT_HOSTING_MODES, `${path}.hostingMode`),
    edition: enumValue(input.edition, TEAM_SEAT_EDITIONS, `${path}.edition`),
    licenseClass,
    licenseEnvironment,
    provider,
    seatLimit: integerValue(input.seatLimit, `${path}.seatLimit`, 1, 10_000),
    entitlementsVersion: integerValue(input.entitlementsVersion, `${path}.entitlementsVersion`),
    grantId: input.grantId === undefined ? undefined : stringValue(input.grantId, `${path}.grantId`),
    nonBillable: booleanValue(input.nonBillable, `${path}.nonBillable`),
  };
}

export function parseTeamSeatPreflightResponse(value: unknown, path = 'preflight'): TeamSeatCommunityPreflightResponse {
  const input = protocolRecord(value, path);
  const license = record(input.license, `${path}.license`);
  const licenseClass = parseTeamSeatLicenseClass(license.licenseClass, `${path}.license.licenseClass`);
  const licenseEnvironment = parseTeamSeatLicenseEnvironment(
    license.licenseEnvironment,
    `${path}.license.licenseEnvironment`,
  );
  assertEnvironmentIsolation({ licenseClass, environment: licenseEnvironment }, `${path}.license`);
  const runtime = record(input.runtime, `${path}.runtime`);
  const team = record(input.team, `${path}.team`);
  const teamProvider = team.provider === null
    ? null
    : enumValue(team.provider, ['stripe', 'manual', 'test'] as const, `${path}.team.provider`);
  if (teamProvider) assertEnvironmentIsolation({ provider: teamProvider, environment: licenseEnvironment }, `${path}.team`);
  const rollout = record(input.rollout, `${path}.rollout`);
  const communityCommercial = record(rollout.communityCommercial, `${path}.rollout.communityCommercial`);
  const cloudCommercial = record(rollout.cloudCommercial, `${path}.rollout.cloudCommercial`);
  const stripeMutations = record(rollout.stripeMutations, `${path}.rollout.stripeMutations`);
  if (!Array.isArray(input.blockers)) invalid(`${path}.blockers`, `${path}.blockers must be an array.`);
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    ready: booleanValue(input.ready, `${path}.ready`),
    mutating: (() => {
      const mutating = booleanValue(input.mutating, `${path}.mutating`);
      if (mutating) invalid(`${path}.mutating`, `${path}.mutating must be false.`);
      return false as const;
    })(),
    nextAction: enumValue(
      input.nextAction,
      ['resolve_blockers', 'manage_seats', 'start_checkout'] as const,
      `${path}.nextAction`,
    ),
    license: {
      licenseId: stringValue(license.licenseId, `${path}.license.licenseId`),
      instanceId: stringValue(license.instanceId, `${path}.license.instanceId`),
      hostingMode: enumValue(license.hostingMode, ['community'] as const, `${path}.license.hostingMode`),
      edition: enumValue(license.edition, TEAM_SEAT_EDITIONS, `${path}.license.edition`),
      licenseClass,
      licenseEnvironment,
      claimed: booleanValue(license.claimed, `${path}.license.claimed`),
      billingOrganizationId: nullableString(license.billingOrganizationId, `${path}.license.billingOrganizationId`),
    },
    runtime: {
      notebookVersion: stringValue(runtime.notebookVersion, `${path}.runtime.notebookVersion`),
      minimumNotebookVersion: nullableString(runtime.minimumNotebookVersion, `${path}.runtime.minimumNotebookVersion`),
      versionSupported: booleanValue(runtime.versionSupported, `${path}.runtime.versionSupported`),
      databaseEngine: enumValue(
        runtime.databaseEngine,
        ['postgres', 'sqlite', 'other'] as const,
        `${path}.runtime.databaseEngine`,
      ),
      teamReady: booleanValue(runtime.teamReady, `${path}.runtime.teamReady`),
    },
    team: {
      active: booleanValue(team.active, `${path}.team.active`),
      provider: teamProvider,
      billingStatus: nullableString(team.billingStatus, `${path}.team.billingStatus`),
      observedQuantity: integerValue(team.observedQuantity, `${path}.team.observedQuantity`),
      approvedQuantity: integerValue(team.approvedQuantity, `${path}.team.approvedQuantity`),
      billedQuantity: integerValue(team.billedQuantity, `${path}.team.billedQuantity`),
      licensedQuantity: integerValue(team.licensedQuantity, `${path}.team.licensedQuantity`),
      entitlementsVersion: integerValue(team.entitlementsVersion, `${path}.team.entitlementsVersion`),
      nonBillable: booleanValue(team.nonBillable, `${path}.team.nonBillable`),
    },
    rollout: {
      communityCommercial: {
        requested: booleanValue(communityCommercial.requested, `${path}.rollout.communityCommercial.requested`),
        effective: booleanValue(communityCommercial.effective, `${path}.rollout.communityCommercial.effective`),
      },
      cloudCommercial: {
        requested: booleanValue(cloudCommercial.requested, `${path}.rollout.cloudCommercial.requested`),
        effective: booleanValue(cloudCommercial.effective, `${path}.rollout.cloudCommercial.effective`),
      },
      stripeMutations: {
        requested: booleanValue(stripeMutations.requested, `${path}.rollout.stripeMutations.requested`),
        effective: booleanValue(stripeMutations.effective, `${path}.rollout.stripeMutations.effective`),
        implementationReady: booleanValue(
          stripeMutations.implementationReady,
          `${path}.rollout.stripeMutations.implementationReady`,
        ),
        billingMode: stringValue(stripeMutations.billingMode, `${path}.rollout.stripeMutations.billingMode`),
        credentialsConfigured: booleanValue(
          stripeMutations.credentialsConfigured,
          `${path}.rollout.stripeMutations.credentialsConfigured`,
        ),
        prorationPolicy: nullableString(
          stripeMutations.prorationPolicy,
          `${path}.rollout.stripeMutations.prorationPolicy`,
        ),
        prorationPolicyConfigured: booleanValue(
          stripeMutations.prorationPolicyConfigured,
          `${path}.rollout.stripeMutations.prorationPolicyConfigured`,
        ),
      },
    },
    blockers: input.blockers.map((entry, index) => {
      const blocker = record(entry, `${path}.blockers[${index}]`);
      return {
        code: enumValue(blocker.code, Object.values(TEAM_SEAT_ERROR_CODES), `${path}.blockers[${index}].code`),
        message: stringValue(blocker.message, `${path}.blockers[${index}].message`),
      };
    }),
  };
}

export function parseTeamSeatClaimStart(value: unknown, path = 'claim'): TeamSeatClaimStart {
  const input = protocolRecord(value, path);
  const verificationUrl = stringValue(input.verificationUrl, `${path}.verificationUrl`);
  try {
    new URL(verificationUrl);
  } catch {
    invalid(`${path}.verificationUrl`, `${path}.verificationUrl must be an absolute URL.`);
  }
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    deviceCode: stringValue(input.deviceCode, `${path}.deviceCode`, { min: 32, max: 128 }),
    userCode: stringValue(input.userCode, `${path}.userCode`, { min: 8, max: 16 }),
    verificationUrl,
    expiresAt: isoTimestamp(input.expiresAt, `${path}.expiresAt`),
    pollIntervalSeconds: integerValue(input.pollIntervalSeconds, `${path}.pollIntervalSeconds`, 1, 300),
  };
}

function parseTokenScopes(value: unknown, path: string): TeamSeatInstanceTokenScope[] {
  if (!Array.isArray(value)) return invalid(path, `${path} must be an array.`);
  const parsed = value.map((entry, index) => (
    enumValue(entry, TEAM_SEAT_INSTANCE_TOKEN_SCOPES, `${path}[${index}]`)
  ));
  if (new Set(parsed).size !== parsed.length) invalid(path, `${path} must not contain duplicate scopes.`);
  return parsed;
}

export function parseTeamSeatClaimPollResult(value: unknown, path = 'claim'): TeamSeatClaimPollResult {
  const input = protocolRecord(value, path);
  if (input.status === 'authorization_pending') {
    return {
      protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
      status: 'authorization_pending',
      pollIntervalSeconds: integerValue(input.pollIntervalSeconds, `${path}.pollIntervalSeconds`, 1, 300),
      expiresAt: isoTimestamp(input.expiresAt, `${path}.expiresAt`),
    };
  }
  if (input.status !== 'approved') return invalid(`${path}.status`, `${path}.status is invalid.`);
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    status: 'approved',
    instanceToken: stringValue(input.instanceToken, `${path}.instanceToken`, { min: 32, max: 512 }),
    tokenType: enumValue(input.tokenType, ['Bearer'] as const, `${path}.tokenType`),
    scopes: parseTokenScopes(input.scopes, `${path}.scopes`),
    expiresAt: nullableTimestamp(input.expiresAt, `${path}.expiresAt`),
    organizationId: stringValue(input.organizationId, `${path}.organizationId`),
    instanceId: stringValue(input.instanceId, `${path}.instanceId`),
  };
}

export function parseTeamSeatTokenRotation(value: unknown, path = 'token'): TeamSeatTokenRotation {
  const input = protocolRecord(value, path);
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    instanceToken: stringValue(input.instanceToken, `${path}.instanceToken`, { min: 32, max: 512 }),
    tokenType: enumValue(input.tokenType, ['Bearer'] as const, `${path}.tokenType`),
    scopes: parseTokenScopes(input.scopes, `${path}.scopes`),
    expiresAt: nullableTimestamp(input.expiresAt, `${path}.expiresAt`),
    instanceId: stringValue(input.instanceId, `${path}.instanceId`),
  };
}

function parseTeamSeatChangeSnapshotState(value: unknown, path: string): TeamSeatChangeSnapshotState {
  const input = record(value, path);
  return {
    revision: integerValue(input.revision, `${path}.revision`),
    observedQuantity: integerValue(input.observedQuantity, `${path}.observedQuantity`),
    licensedQuantity: integerValue(input.licensedQuantity, `${path}.licensedQuantity`),
    approvedQuantity: integerValue(input.approvedQuantity, `${path}.approvedQuantity`),
    billedQuantity: integerValue(input.billedQuantity, `${path}.billedQuantity`),
    billingStatus: stringValue(input.billingStatus, `${path}.billingStatus`),
  };
}

export function parseTeamSeatPrepareResponse(value: unknown, path = 'prepare'): TeamSeatPrepareResponse {
  const input = record(value, path);
  return {
    quote: parseTeamSeatQuote(input.quote, `${path}.quote`),
    authorization: parseTeamSeatAuthorization(input.authorization, `${path}.authorization`),
    requiresBillingApproval: booleanValue(input.requiresBillingApproval, `${path}.requiresBillingApproval`),
    snapshot: parseTeamSeatChangeSnapshotState(input.snapshot, `${path}.snapshot`),
  };
}

export function parseTeamSeatOperation(value: unknown, path = 'operation'): TeamSeatOperation {
  const input = protocolRecord(value, path);
  const provider = enumValue(input.provider, ['stripe', 'manual', 'test'] as const, `${path}.provider`);
  const environment = parseTeamSeatLicenseEnvironment(input.environment, `${path}.environment`);
  assertEnvironmentIsolation({ provider, environment }, path);
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    operationId: stringValue(input.operationId, `${path}.operationId`),
    operationKey: stringValue(input.operationKey, `${path}.operationKey`),
    operationType: enumValue(input.operationType, TEAM_SEAT_CHANGE_TYPES, `${path}.operationType`),
    provider,
    environment,
    status: enumValue(input.status, TEAM_SEAT_OPERATION_STATUSES, `${path}.status`),
    paymentStatus: nullableString(input.paymentStatus, `${path}.paymentStatus`),
    previousQuantity: integerValue(input.previousQuantity, `${path}.previousQuantity`),
    requestedQuantity: integerValue(input.requestedQuantity, `${path}.requestedQuantity`),
    effectiveQuantity: nullableInteger(input.effectiveQuantity, `${path}.effectiveQuantity`),
    retryCount: integerValue(input.retryCount, `${path}.retryCount`),
    lastError: nullableString(input.lastError, `${path}.lastError`),
    effectiveAt: nullableTimestamp(input.effectiveAt, `${path}.effectiveAt`),
    entitlementsVersion: nullableInteger(input.entitlementsVersion, `${path}.entitlementsVersion`),
    certificateReissueStatus: enumValue(
      input.certificateReissueStatus,
      ['pending', 'issued', 'failed'] as const,
      `${path}.certificateReissueStatus`,
    ),
    createdAt: isoTimestamp(input.createdAt, `${path}.createdAt`),
    updatedAt: isoTimestamp(input.updatedAt, `${path}.updatedAt`),
  };
}

export function parseTeamSeatLicenseRefresh(
  value: unknown,
  path = 'licenseRefresh',
): TeamSeatLicenseRefresh {
  const input = record(value, path);
  const details = record(input.details, `${path}.details`);
  const licenseClass = parseTeamSeatLicenseClass(details.licenseClass, `${path}.details.licenseClass`);
  const licenseEnvironment = parseTeamSeatLicenseEnvironment(
    details.licenseEnvironment,
    `${path}.details.licenseEnvironment`,
  );
  assertEnvironmentIsolation({ licenseClass, environment: licenseEnvironment }, `${path}.details`);
  return {
    license: stringValue(input.license, `${path}.license`, { min: 64 }),
    details: {
      id: stringValue(details.id, `${path}.details.id`),
      plan: stringValue(details.plan, `${path}.details.plan`),
      status: stringValue(details.status, `${path}.details.status`),
      instanceId: stringValue(details.instanceId, `${path}.details.instanceId`),
      hostingMode: enumValue(details.hostingMode, TEAM_SEAT_HOSTING_MODES, `${path}.details.hostingMode`),
      edition: enumValue(details.edition, TEAM_SEAT_EDITIONS, `${path}.details.edition`),
      licenseClass,
      licenseEnvironment,
      billingOrganizationId: nullableString(
        details.billingOrganizationId,
        `${path}.details.billingOrganizationId`,
      ),
      entitlementsVersion: integerValue(
        details.entitlementsVersion,
        `${path}.details.entitlementsVersion`,
      ),
      deploymentMode: stringValue(details.deploymentMode, `${path}.details.deploymentMode`),
      features: booleanRecord(details.features, `${path}.details.features`),
      quotas: numberRecord(details.quotas, `${path}.details.quotas`),
      activatedAt: nullableTimestamp(details.activatedAt, `${path}.details.activatedAt`),
      expiresAt: nullableTimestamp(details.expiresAt, `${path}.details.expiresAt`),
    },
  };
}

export function parseTeamSeatExecuteResponse(value: unknown, path = 'execute'): TeamSeatExecuteResponse {
  const input = record(value, path);
  return {
    operation: parseTeamSeatOperation(input.operation, `${path}.operation`),
    replayed: booleanValue(input.replayed, `${path}.replayed`),
    license: input.license === null ? null : parseTeamSeatLicenseRefresh(input.license, `${path}.license`),
  };
}

export function parseTeamSeatSnapshotResponse(value: unknown, path = 'snapshotResponse'): TeamSeatSnapshotResponse {
  const input = record(value, path);
  const snapshotInput = record(input.snapshot, `${path}.snapshot`);
  const snapshot = parseTeamSeatMembershipSnapshot(snapshotInput, `${path}.snapshot`);
  return {
    snapshot: {
      ...snapshot,
      snapshotId: stringValue(snapshotInput.snapshotId, `${path}.snapshot.snapshotId`),
      receivedAt: isoTimestamp(snapshotInput.receivedAt, `${path}.snapshot.receivedAt`),
      reconciledAt: nullableTimestamp(snapshotInput.reconciledAt, `${path}.snapshot.reconciledAt`),
      driftStatus: parseTeamSeatDriftStatus(snapshotInput.driftStatus, `${path}.snapshot.driftStatus`),
    },
    observedQuantity: integerValue(input.observedQuantity, `${path}.observedQuantity`),
    billedQuantity: integerValue(input.billedQuantity, `${path}.billedQuantity`),
    licensedQuantity: integerValue(input.licensedQuantity, `${path}.licensedQuantity`),
    expectedLicensedQuantity: integerValue(
      input.expectedLicensedQuantity,
      `${path}.expectedLicensedQuantity`,
    ),
    approvedQuantity: integerValue(input.approvedQuantity, `${path}.approvedQuantity`),
    billingStatus: stringValue(input.billingStatus, `${path}.billingStatus`),
    nextReportAt: isoTimestamp(input.nextReportAt, `${path}.nextReportAt`),
    replayed: booleanValue(input.replayed, `${path}.replayed`),
  };
}

export function createTeamSeatClaimStartRequest(input: {
  licenseCertificate: string;
  instanceId: string;
}): TeamSeatClaimStartRequest {
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    licenseCertificate: stringValue(input.licenseCertificate, 'licenseCertificate', { min: 64, max: 32_768 }),
    instanceId: stringValue(input.instanceId, 'instanceId', { min: 8, max: 128 }),
  };
}

export function createTeamSeatClaimPollRequest(deviceCode: string): TeamSeatClaimPollRequest {
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    deviceCode: stringValue(deviceCode, 'deviceCode', { min: 32, max: 128 }),
  };
}

export function createTeamSeatTokenLifecycleRequest(): TeamSeatTokenLifecycleRequest {
  return { protocolVersion: TEAM_SEAT_PROTOCOL_VERSION };
}

export function createTeamSeatPreflightRequest(input: {
  notebookVersion: string;
  databaseEngine: 'postgres' | 'sqlite' | 'other';
  teamReady: boolean;
}): TeamSeatCommunityPreflightRequest {
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    notebookVersion: stringValue(input.notebookVersion, 'notebookVersion', { max: 64 }),
    databaseEngine: enumValue(input.databaseEngine, ['postgres', 'sqlite', 'other'] as const, 'databaseEngine'),
    teamReady: booleanValue(input.teamReady, 'teamReady'),
  };
}

export function createTeamSeatPrepareRequest(input: {
  desiredQuantity: number;
  triggerType: TeamSeatChangeType;
  externalReference?: string | null;
}): TeamSeatPrepareRequest {
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    desiredQuantity: integerValue(input.desiredQuantity, 'desiredQuantity', 1, 10_000),
    triggerType: enumValue(input.triggerType, TEAM_SEAT_CHANGE_TYPES, 'triggerType'),
    externalReference: input.externalReference === undefined
      ? undefined
      : input.externalReference === null
        ? null
        : stringValue(input.externalReference, 'externalReference', { max: 256 }),
  };
}

export function createTeamSeatExecuteRequest(input: {
  authorizationId: string;
  operationKey: string;
  operationType: TeamSeatChangeType;
}): TeamSeatExecuteRequest {
  return {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    authorizationId: stringValue(input.authorizationId, 'authorizationId'),
    operationKey: stringValue(input.operationKey, 'operationKey'),
    operationType: enumValue(input.operationType, TEAM_SEAT_CHANGE_TYPES, 'operationType'),
  };
}

export function createTeamSeatSnapshotRequest(input: Omit<TeamSeatSnapshotRequest, 'protocolVersion'>): TeamSeatSnapshotRequest {
  const request: TeamSeatSnapshotRequest = {
    ...input,
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
  };
  const parsed = parseTeamSeatMembershipSnapshot(request, 'snapshot');
  if (!/^[a-f0-9]{64}$/u.test(parsed.snapshotHash)) {
    invalid('snapshot.snapshotHash', 'snapshot.snapshotHash must be a SHA-256 hex digest.');
  }
  if (parsed.memberHashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) {
    invalid('snapshot.memberHashes', 'Every snapshot member hash must be a SHA-256 hex digest.');
  }
  if (new Set(parsed.memberHashes).size !== parsed.memberHashes.length) {
    invalid('snapshot.memberHashes', 'Snapshot member hashes must be unique.');
  }
  const roleCount = Object.values(parsed.roleSummary).reduce((sum, count) => sum + count, 0);
  if (roleCount !== parsed.observedQuantity || parsed.memberHashes.length !== parsed.observedQuantity) {
    invalid('snapshot.observedQuantity', 'Snapshot counts must match observedQuantity.');
  }
  return parsed;
}
