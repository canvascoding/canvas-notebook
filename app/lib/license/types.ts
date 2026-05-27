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
  source: 'env' | 'stored' | 'none';
  error?: string;
}
