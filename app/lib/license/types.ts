export type LicensePlan = 'unregistered' | 'community' | 'pro' | 'managed';

export interface LicenseCert {
  sub: string;
  plan: LicensePlan;
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
  expiresAt: string | null;
  features: Record<string, boolean>;
  quotas: Record<string, number>;
  source: 'env' | 'stored' | 'managed' | 'none';
  error?: 'missing_public_key' | 'public_key_unavailable' | 'control_plane_unreachable' | 'untrusted_public_key' | 'license_expired';
  code?: string;
}
