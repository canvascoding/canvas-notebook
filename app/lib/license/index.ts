import 'server-only';

import { getControlPlaneLicenseBaseUrl, getLicenseInstanceId } from './instance';
import { verifyLicenseJwt } from './jwt';
import { loadStoredLicenseCert, saveLicenseCert } from './storage';
import type { LicenseCert, LicenseStatus } from './types';

function statusFromPayload(payload: LicenseCert, instanceId: string, source: LicenseStatus['source']): LicenseStatus {
  return {
    plan: payload.plan,
    licensed: true,
    instanceId,
    expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    features: payload.features || {},
    quotas: payload.quotas || {},
    source,
  };
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  const instanceId = getLicenseInstanceId();

  const envCert = process.env.CANVAS_LICENSE_CERT?.trim();
  if (envCert) {
    const payload = verifyLicenseJwt(envCert, instanceId);
    if (payload) {
      await saveLicenseCert(envCert, payload);
      return statusFromPayload(payload, instanceId, 'env');
    }
  }

  const stored = await loadStoredLicenseCert(instanceId);
  if (stored) {
    const payload = verifyLicenseJwt(stored, instanceId);
    if (payload) return statusFromPayload(payload, instanceId, 'stored');
  }

  return {
    plan: 'unregistered',
    licensed: false,
    instanceId,
    expiresAt: null,
    features: {},
    quotas: {},
    source: 'none',
    error: process.env.CANVAS_LICENSE_PUBLIC_KEY ? undefined : 'missing_public_key',
  };
}

export async function requireLicenseStatus(): Promise<LicenseStatus> {
  return getLicenseStatus();
}

export async function activateLicenseCert(cert: string): Promise<LicenseStatus> {
  const instanceId = getLicenseInstanceId();
  const payload = verifyLicenseJwt(cert, instanceId);
  if (!payload) {
    throw new Error('License certificate is invalid for this instance.');
  }
  await saveLicenseCert(cert, payload);
  return statusFromPayload(payload, instanceId, 'stored');
}

export function getLicenseControlPlaneUrl(): string {
  const baseUrl = getControlPlaneLicenseBaseUrl();
  if (!baseUrl) {
    throw new Error('CANVAS_CONTROL_PLANE_URL or CANVAS_LICENSE_CONTROL_PLANE_URL is not configured.');
  }
  return baseUrl;
}
