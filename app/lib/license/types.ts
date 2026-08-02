import {
  TEAM_SEAT_EDITIONS,
  TEAM_SEAT_HOSTING_MODES,
  TEAM_SEAT_LICENSE_CLASSES,
  TEAM_SEAT_LICENSE_ENVIRONMENTS,
  TEAM_SEAT_PROTOCOL_VERSION,
  type TeamSeatEdition,
  type TeamSeatHostingMode,
  type TeamSeatLicenseClass,
  type TeamSeatLicenseEnvironment,
} from './team-seat-contract';

export type LicensePlan = 'unregistered' | 'community' | 'pro' | 'managed';
export type LicenseDeploymentMode = 'community' | 'managed-single' | 'managed-team' | 'enterprise-onprem' | string;
export type LicenseDatabaseProvider = 'sqlite' | 'postgres' | string;
export type LicenseVectorProvider = 'none' | 'pgvector' | 'external' | string;
export type LicenseHostingMode = TeamSeatHostingMode;
export type LicenseEdition = TeamSeatEdition;
export type LicenseClass = TeamSeatLicenseClass;
export type LicenseEnvironment = TeamSeatLicenseEnvironment;
export type LicenseProtocolVersion = typeof TEAM_SEAT_PROTOCOL_VERSION | 'legacy';
export type LicenseProductVariant = 'community-solo' | 'community-team' | 'cloud-solo' | 'cloud-team';
export type LicenseRuntimeState = 'active' | 'grace_required' | 'inactive';
export type LicenseValidationErrorCode =
  | 'LICENSE_CERT_MALFORMED'
  | 'LICENSE_CERT_ALGORITHM_INVALID'
  | 'LICENSE_CERT_KEY_ID_MISSING'
  | 'LICENSE_CERT_KEY_ID_UNKNOWN'
  | 'LICENSE_CERT_SIGNATURE_INVALID'
  | 'LICENSE_CERT_ISSUER_INVALID'
  | 'LICENSE_CERT_AUDIENCE_INVALID'
  | 'LICENSE_CERT_INSTANCE_MISMATCH'
  | 'LICENSE_CERT_STATUS_INVALID'
  | 'LICENSE_CERT_NOT_YET_VALID'
  | 'LICENSE_CERT_EXPIRED'
  | 'LICENSE_CERT_PLAN_INVALID'
  | 'LICENSE_CERT_CLAIMS_INVALID'
  | 'LICENSE_CERT_ENVIRONMENT_INVALID'
  | 'LICENSE_CERT_PUBLIC_KEY_UNAVAILABLE'
  | 'LICENSE_CERT_ROLLBACK';

export interface LicenseCert {
  sub: string;
  plan: LicensePlan;
  status?: 'active' | 'issued' | string;
  protocolVersion?: string;
  licenseId?: string;
  instanceId?: string;
  hostingMode?: LicenseHostingMode | string;
  edition?: LicenseEdition | string;
  licenseClass?: LicenseClass | string;
  licenseEnvironment?: LicenseEnvironment | string;
  seatLimit?: number;
  grantId?: string;
  nonBillable?: boolean;
  deploymentMode?: LicenseDeploymentMode;
  databaseProvider?: LicenseDatabaseProvider;
  vectorProvider?: LicenseVectorProvider;
  postgresRequired?: boolean;
  capabilities?: Record<string, boolean>;
  organizationId?: string;
  entitlementsVersion?: number;
  features?: Record<string, boolean>;
  quotas?: Record<string, number>;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
}

export interface NormalizedLicenseProductClaims {
  protocolVersion: LicenseProtocolVersion;
  hostingMode: LicenseHostingMode;
  edition: LicenseEdition;
  licenseClass: LicenseClass;
  licenseEnvironment: LicenseEnvironment;
  seatLimit: number;
}

export interface LicenseStatus {
  plan: LicensePlan;
  licensed: boolean;
  instanceId: string;
  licenseState: LicenseRuntimeState;
  protocolVersion: LicenseProtocolVersion | null;
  hostingMode: LicenseHostingMode | null;
  edition: LicenseEdition | null;
  licenseClass: LicenseClass | null;
  licenseEnvironment: LicenseEnvironment | null;
  seatLimit: number | null;
  deploymentMode: LicenseDeploymentMode | null;
  databaseProvider: LicenseDatabaseProvider | null;
  vectorProvider: LicenseVectorProvider | null;
  postgresRequired: boolean;
  capabilities: Record<string, boolean>;
  organizationId: string | null;
  entitlementsVersion: number | null;
  expiresAt: string | null;
  features: Record<string, boolean>;
  quotas: Record<string, number>;
  source: 'env' | 'stored' | 'managed' | 'none';
  error?:
    | 'missing_public_key'
    | 'public_key_unavailable'
    | 'control_plane_unreachable'
    | 'untrusted_public_key'
    | 'license_expired'
    | 'license_invalid'
    | 'license_environment_invalid'
    | 'license_rollback';
  code?: LicenseValidationErrorCode;
}

function includesValue<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

function legacyQuotaSeatLimit(payload: LicenseCert): number {
  for (const key of ['users', 'maxTeamMembers', 'teamMembers']) {
    const value = positiveInteger(payload.quotas?.[key]);
    if (value !== null) return value;
  }
  return 1;
}

function inferLegacyHostingMode(payload: LicenseCert): LicenseHostingMode {
  if (payload.plan === 'managed') return 'cloud';
  if (payload.deploymentMode === 'managed-single' || payload.deploymentMode === 'managed-team') return 'cloud';
  return 'community';
}

function inferLegacyEdition(payload: LicenseCert): LicenseEdition {
  if (payload.deploymentMode === 'managed-single' || payload.deploymentMode === 'community') {
    return payload.plan === 'pro' ? 'team' : 'solo';
  }
  if (
    payload.plan === 'pro'
    || payload.deploymentMode === 'managed-team'
    || payload.deploymentMode === 'enterprise-onprem'
    || payload.features?.teamWorkspace === true
    || payload.features?.multiUser === true
    || payload.capabilities?.teamWorkspace === true
    || payload.capabilities?.multiUser === true
    || legacyQuotaSeatLimit(payload) > 1
  ) {
    return 'team';
  }
  return 'solo';
}

export function normalizeLicenseProductClaims(payload: LicenseCert): NormalizedLicenseProductClaims | null {
  const protocolVersion = payload.protocolVersion;
  const modern = protocolVersion !== undefined;
  if (modern && protocolVersion !== TEAM_SEAT_PROTOCOL_VERSION) return null;

  const hostingMode = payload.hostingMode === undefined
    ? modern ? null : inferLegacyHostingMode(payload)
    : includesValue(TEAM_SEAT_HOSTING_MODES, payload.hostingMode) ? payload.hostingMode : null;
  const edition = payload.edition === undefined
    ? modern ? null : inferLegacyEdition(payload)
    : includesValue(TEAM_SEAT_EDITIONS, payload.edition) ? payload.edition : null;
  const licenseClass = payload.licenseClass === undefined
    ? modern ? null : 'commercial'
    : includesValue(TEAM_SEAT_LICENSE_CLASSES, payload.licenseClass) ? payload.licenseClass : null;
  const licenseEnvironment = payload.licenseEnvironment === undefined
    ? modern ? null : 'production'
    : includesValue(TEAM_SEAT_LICENSE_ENVIRONMENTS, payload.licenseEnvironment) ? payload.licenseEnvironment : null;
  const seatLimit = payload.seatLimit === undefined
    ? modern ? null : legacyQuotaSeatLimit(payload)
    : positiveInteger(payload.seatLimit);

  if (
    hostingMode === null
    || edition === null
    || licenseClass === null
    || licenseEnvironment === null
    || seatLimit === null
  ) {
    return null;
  }

  return {
    protocolVersion: modern ? TEAM_SEAT_PROTOCOL_VERSION : 'legacy',
    hostingMode,
    edition,
    licenseClass,
    licenseEnvironment,
    seatLimit,
  };
}

export function licenseProductVariant(
  product: Pick<NormalizedLicenseProductClaims, 'hostingMode' | 'edition'>,
): LicenseProductVariant {
  return `${product.hostingMode}-${product.edition}`;
}
