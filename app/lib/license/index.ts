import 'server-only';

import { getControlPlaneLicenseBaseUrl, getLicenseInstanceId } from './instance';
import { decodeLicenseJwt, verifyLicenseJwt } from './jwt';
import { resolveLicensePublicKeys } from './public-key';
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

function expiredLicenseError(token: string | null, instanceId: string): LicenseStatus['error'] | undefined {
  if (!token) return undefined;
  const decoded = decodeLicenseJwt(token);
  if (decoded?.sub === instanceId && decoded.exp && decoded.exp * 1000 <= Date.now()) {
    return 'license_expired';
  }
  return undefined;
}

async function publicKeyUnavailableError(): Promise<LicenseStatus['error'] | undefined> {
  const resolution = await resolveLicensePublicKeys();
  if (resolution.keys.length > 0) return undefined;
  if (resolution.error === 'untrusted_key') return 'untrusted_public_key';
  if (resolution.error === 'unreachable') return 'control_plane_unreachable';
  return 'public_key_unavailable';
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  const instanceId = getLicenseInstanceId();

  const envCert = process.env.CANVAS_LICENSE_CERT?.trim();
  if (envCert) {
    const payload = await verifyLicenseJwt(envCert, instanceId);
    if (payload) {
      await saveLicenseCert(envCert, payload);
      return statusFromPayload(payload, instanceId, 'env');
    }
  }

  const stored = await loadStoredLicenseCert(instanceId);
  if (stored) {
    const payload = await verifyLicenseJwt(stored, instanceId);
    if (payload) return statusFromPayload(payload, instanceId, 'stored');
  }

  const error = expiredLicenseError(envCert || stored, instanceId) || await publicKeyUnavailableError();

  return {
    plan: 'unregistered',
    licensed: false,
    instanceId,
    expiresAt: null,
    features: {},
    quotas: {},
    source: 'none',
    error,
  };
}

export async function requireLicenseStatus(): Promise<LicenseStatus> {
  return getLicenseStatus();
}

export async function activateLicenseCert(cert: string): Promise<LicenseStatus> {
  const instanceId = getLicenseInstanceId();
  const payload = await verifyLicenseJwt(cert, instanceId);
  if (!payload) {
    throw new Error('License certificate is invalid for this instance.');
  }
  await saveLicenseCert(cert, payload);
  return statusFromPayload(payload, instanceId, 'stored');
}

export function getLicenseControlPlaneUrl(): string {
  return getControlPlaneLicenseBaseUrl();
}
