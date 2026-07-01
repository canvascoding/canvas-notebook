import 'server-only';

import { getControlPlaneLicenseBaseUrl, getLicenseInstanceId } from './instance';
import { decodeLicenseJwt, verifyLicenseJwt } from './jwt';
import { logLicenseInfoThrottled } from './logging';
import { resolveLicensePublicKeys } from './public-key';
import { loadStoredLicenseCert, saveLicenseCert } from './storage';
import type { LicenseCert, LicenseStatus } from './types';

const LOG_PREFIX = '[license/status]';
const MANAGED_LOG_PREFIX = '[license/managed]';

function getControlPlaneHost(): string {
  try {
    return new URL(getControlPlaneLicenseBaseUrl()).host;
  } catch {
    return 'invalid_control_plane_url';
  }
}

function certLogContext(token: string | null, instanceId: string) {
  const decoded = token ? decodeLicenseJwt(token) : null;
  return {
    instanceId,
    certSubject: decoded?.sub,
    certPlan: decoded?.plan,
    certExpiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null,
    subjectMatchesInstance: decoded?.sub === instanceId,
  };
}

function statusFromPayload(payload: LicenseCert, instanceId: string, source: LicenseStatus['source']): LicenseStatus {
  return {
    plan: payload.plan,
    licensed: true,
    instanceId,
    deploymentMode: payload.deploymentMode || null,
    databaseProvider: payload.databaseProvider || null,
    postgresRequired: payload.postgresRequired === true,
    organizationId: payload.organizationId || null,
    entitlementsVersion: typeof payload.entitlementsVersion === 'number' ? payload.entitlementsVersion : null,
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
    console.warn(`${MANAGED_LOG_PREFIX} managed license unavailable: missing CANVAS_INSTANCE_TOKEN`, {
      instanceId,
      managedEnabled: process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true',
      controlPlaneHost: getControlPlaneHost(),
    });
    return null;
  }

  try {
    logLicenseInfoThrottled(MANAGED_LOG_PREFIX, 'requesting managed license from control plane', {
      instanceId,
      managedEnabled: process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true',
      hasInstanceToken: true,
      controlPlaneHost: getControlPlaneHost(),
    });
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
      console.warn(`${MANAGED_LOG_PREFIX} control plane did not return a managed license`, {
        instanceId,
        status: response.status,
        code: payload.code,
        error: payload.error,
      });
      return null;
    }
    logLicenseInfoThrottled(MANAGED_LOG_PREFIX, 'resolved managed license from control plane', {
      instanceId,
      status: response.status,
      controlPlaneHost: getControlPlaneHost(),
    });
    return payload.license;
  } catch (error) {
    console.warn(`${MANAGED_LOG_PREFIX} failed to resolve managed license`, {
      instanceId,
      controlPlaneHost: getControlPlaneHost(),
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
    console.warn(`${MANAGED_LOG_PREFIX} managed license certificate is invalid for this instance`, certLogContext(cert, instanceId));
    return null;
  }
  await saveLicenseCert(cert, payload);
  logLicenseInfoThrottled(MANAGED_LOG_PREFIX, 'managed license verified and stored', {
    instanceId,
    plan: payload.plan,
    expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
  });
  return statusFromPayload(payload, instanceId, 'managed');
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  const instanceId = getLicenseInstanceId();

  const envCert = process.env.CANVAS_LICENSE_CERT?.trim();
  if (envCert) {
    const payload = await verifyLicenseJwt(envCert, instanceId);
    if (payload) {
      await saveLicenseCert(envCert, payload);
      logLicenseInfoThrottled(LOG_PREFIX, 'resolved from env certificate', {
        instanceId,
        plan: payload.plan,
        expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
        managedConfigured: isManagedLicenseAvailable(),
      });
      return statusFromPayload(payload, instanceId, 'env');
    }
    console.warn(`${LOG_PREFIX} env certificate did not verify`, {
      ...certLogContext(envCert, instanceId),
      managedConfigured: isManagedLicenseAvailable(),
    });
  }

  const stored = await loadStoredLicenseCert(instanceId);
  if (stored) {
    const payload = await verifyLicenseJwt(stored, instanceId);
    if (payload) {
      logLicenseInfoThrottled(LOG_PREFIX, 'resolved from stored certificate', {
        instanceId,
        plan: payload.plan,
        expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
        managedConfigured: isManagedLicenseAvailable(),
      });
      return statusFromPayload(payload, instanceId, 'stored');
    }
    console.warn(`${LOG_PREFIX} stored certificate did not verify`, {
      ...certLogContext(stored, instanceId),
      managedConfigured: isManagedLicenseAvailable(),
    });
  }

  const managedStatus = await getManagedLicenseStatus(instanceId);
  if (managedStatus) return managedStatus;

  const error = expiredLicenseError(envCert || stored, instanceId) || await publicKeyUnavailableError();

  console.warn(`${LOG_PREFIX} unresolved license status`, {
    instanceId,
    error,
    managedConfigured: isManagedLicenseAvailable(),
    hasEnvCert: Boolean(envCert),
    hasStoredCert: Boolean(stored),
    controlPlaneHost: getControlPlaneHost(),
  });

  return {
    plan: 'unregistered',
    licensed: false,
    instanceId,
    deploymentMode: null,
    databaseProvider: null,
    postgresRequired: false,
    organizationId: null,
    entitlementsVersion: null,
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
