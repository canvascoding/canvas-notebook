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

function isManagedLicenseAvailable(): boolean {
  return (
    process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' ||
    Boolean(process.env.CANVAS_INSTANCE_TOKEN?.trim())
  );
}

async function fetchManagedLicenseCert(instanceId: string): Promise<string | null> {
  const token = process.env.CANVAS_INSTANCE_TOKEN?.trim();
  if (!token) {
    console.warn('[license/managed] managed license unavailable: missing CANVAS_INSTANCE_TOKEN', { instanceId });
    return null;
  }

  try {
    const response = await fetch(`${getControlPlaneLicenseBaseUrl()}/v1/license/managed`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json().catch(() => ({})) as { license?: string; error?: string; code?: string };
    if (!response.ok || !payload.license) {
      console.warn('[license/managed] control plane did not return a managed license', {
        instanceId,
        status: response.status,
        code: payload.code,
        error: payload.error,
      });
      return null;
    }
    console.info('[license/managed] resolved managed license from control plane', { instanceId });
    return payload.license;
  } catch (error) {
    console.warn('[license/managed] failed to resolve managed license', {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function getManagedLicenseStatus(instanceId: string): Promise<LicenseStatus | null> {
  if (!isManagedLicenseAvailable()) return null;
  const cert = await fetchManagedLicenseCert(instanceId);
  if (!cert) return null;
  const payload = await verifyLicenseJwt(cert, instanceId);
  if (!payload) {
    console.warn('[license/managed] managed license certificate is invalid for this instance', { instanceId });
    return null;
  }
  await saveLicenseCert(cert, payload);
  return statusFromPayload(payload, instanceId, 'managed');
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

  const managedStatus = await getManagedLicenseStatus(instanceId);
  if (managedStatus) return managedStatus;

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
