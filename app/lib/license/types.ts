export type LicensePlan = 'unregistered' | 'community' | 'pro' | 'managed';
export type LicenseDeploymentMode = 'community' | 'managed-single' | 'managed-team' | 'enterprise-onprem' | string;
export type LicenseDatabaseProvider = 'sqlite' | 'postgres' | string;

export interface LicenseCert {
  sub: string;
  plan: LicensePlan;
  status?: 'active' | 'issued' | string;
  deploymentMode?: LicenseDeploymentMode;
  databaseProvider?: LicenseDatabaseProvider;
  postgresRequired?: boolean;
  organizationId?: string;
  entitlementsVersion?: number;
  features?: Record<string, boolean>;
  quotas?: Record<string, number>;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
}

export interface LicenseStatus {
  plan: LicensePlan;
  licensed: boolean;
  instanceId: string;
  deploymentMode: LicenseDeploymentMode | null;
  databaseProvider: LicenseDatabaseProvider | null;
  postgresRequired: boolean;
  organizationId: string | null;
  entitlementsVersion: number | null;
  expiresAt: string | null;
  features: Record<string, boolean>;
  quotas: Record<string, number>;
  source: 'env' | 'stored' | 'managed' | 'none';
  error?: 'missing_public_key' | 'public_key_unavailable' | 'control_plane_unreachable' | 'untrusted_public_key' | 'license_expired';
  code?: string;
}
