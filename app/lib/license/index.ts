import 'server-only';

import { getControlPlaneLicenseBaseUrl, getLicenseInstanceId } from './instance';
import {
  decodeLicenseJwt,
  LicenseCertificateValidationError,
  verifyLicenseJwtDetailed,
  type LicenseVerificationResult,
} from './jwt';
import { logLicenseInfoThrottled } from './logging';
import { resolveLicensePublicKeys } from './public-key';
import {
  LicenseCertificateStorageError,
  loadStoredLicenseCert,
  saveLicenseCert,
} from './storage';
import {
  normalizeLicenseProductClaims,
  type LicenseCert,
  type LicenseStatus,
  type LicenseValidationErrorCode,
} from './types';

const LOG_PREFIX = '[license/status]';
const MANAGED_LOG_PREFIX = '[license/managed]';

type LicenseResolutionFailure = Extract<LicenseVerificationResult, { ok: false }> & {
  source: LicenseStatus['source'];
};

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

function statusFromPayload(
  payload: LicenseCert,
  instanceId: string,
  source: LicenseStatus['source'],
): LicenseStatus | null {
  const product = normalizeLicenseProductClaims(payload);
  if (!product) return null;

  return {
    plan: payload.plan,
    licensed: true,
    instanceId,
    licenseState: 'active',
    ...product,
    deploymentMode: payload.deploymentMode || null,
    databaseProvider: payload.databaseProvider || null,
    vectorProvider: payload.vectorProvider || null,
    postgresRequired: payload.postgresRequired === true,
    capabilities: payload.capabilities || {},
    organizationId: payload.organizationId || null,
    entitlementsVersion: typeof payload.entitlementsVersion === 'number' ? payload.entitlementsVersion : null,
    expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    features: payload.features || {},
    quotas: payload.quotas || {},
    source,
  };
}

function errorFromValidationCode(code: LicenseValidationErrorCode): LicenseStatus['error'] {
  if (code === 'LICENSE_CERT_EXPIRED') return 'license_expired';
  if (code === 'LICENSE_CERT_ENVIRONMENT_INVALID') return 'license_environment_invalid';
  if (code === 'LICENSE_CERT_ROLLBACK') return 'license_rollback';
  if (code === 'LICENSE_CERT_PUBLIC_KEY_UNAVAILABLE') return 'public_key_unavailable';
  return 'license_invalid';
}

function unresolvedStatus(
  instanceId: string,
  failure?: LicenseResolutionFailure,
  publicKeyError?: LicenseStatus['error'],
): LicenseStatus {
  const payload = failure?.code === 'LICENSE_CERT_EXPIRED' ? failure.payload : undefined;
  const product = payload ? normalizeLicenseProductClaims(payload) : null;
  const graceRequired = failure?.code === 'LICENSE_CERT_EXPIRED' && product?.edition === 'team';
  return {
    plan: payload?.plan ?? 'unregistered',
    licensed: false,
    instanceId,
    licenseState: graceRequired ? 'grace_required' : 'inactive',
    protocolVersion: product?.protocolVersion ?? null,
    hostingMode: product?.hostingMode ?? null,
    edition: product?.edition ?? null,
    licenseClass: product?.licenseClass ?? null,
    licenseEnvironment: product?.licenseEnvironment ?? null,
    seatLimit: product?.seatLimit ?? null,
    deploymentMode: payload?.deploymentMode || null,
    databaseProvider: null,
    vectorProvider: null,
    postgresRequired: false,
    capabilities: {},
    organizationId: payload?.organizationId || null,
    entitlementsVersion: typeof payload?.entitlementsVersion === 'number'
      ? payload.entitlementsVersion
      : null,
    expiresAt: payload?.exp ? new Date(payload.exp * 1000).toISOString() : null,
    features: {},
    quotas: {},
    source: failure?.source ?? 'none',
    error: publicKeyError || (failure ? errorFromValidationCode(failure.code) : undefined),
    code: publicKeyError ? undefined : failure?.code,
  };
}

function storageFailure(
  error: unknown,
  payload: LicenseCert,
  source: LicenseStatus['source'],
): LicenseResolutionFailure | null {
  if (error instanceof LicenseCertificateStorageError) {
    return {
      ok: false,
      code: error.code,
      payload,
      source,
    };
  }
  return null;
}

async function publicKeyUnavailableError(): Promise<LicenseStatus['error'] | undefined> {
  const resolution = await resolveLicensePublicKeys();
  if (resolution.keys.length > 0) return undefined;
  if (resolution.error === 'untrusted_key') return 'untrusted_public_key';
  if (resolution.error === 'unreachable') return 'control_plane_unreachable';
  return 'public_key_unavailable';
}

export function isManagedLicenseConfigured(): boolean {
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

async function getManagedLicenseStatus(instanceId: string): Promise<{
  status: LicenseStatus | null;
  failure?: LicenseResolutionFailure;
}> {
  if (!isManagedLicenseConfigured()) return { status: null };
  const cert = await fetchManagedLicenseCert(instanceId);
  if (!cert) return { status: null };
  const verification = await verifyLicenseJwtDetailed(cert, instanceId);
  if (!verification.ok) {
    console.warn(`${MANAGED_LOG_PREFIX} managed license certificate was rejected`, {
      ...certLogContext(cert, instanceId),
      code: verification.code,
    });
    return { status: null, failure: { ...verification, source: 'managed' } };
  }
  const payload = verification.payload;
  const status = statusFromPayload(payload, instanceId, 'managed');
  if (!status) {
    console.warn(`${MANAGED_LOG_PREFIX} managed license certificate has invalid product claims`, certLogContext(cert, instanceId));
    return {
      status: null,
      failure: {
        ok: false,
        code: 'LICENSE_CERT_CLAIMS_INVALID',
        payload,
        source: 'managed',
      },
    };
  }
  try {
    await saveLicenseCert(cert, payload);
  } catch (error) {
    const failure = storageFailure(error, payload, 'managed');
    if (!failure) throw error;
    console.warn(`${MANAGED_LOG_PREFIX} managed license certificate rollback rejected`, {
      ...certLogContext(cert, instanceId),
      code: failure.code,
    });
    return { status: null, failure };
  }
  logLicenseInfoThrottled(MANAGED_LOG_PREFIX, 'managed license verified and stored', {
    instanceId,
    plan: payload.plan,
    expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
  });
  return { status };
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  const instanceId = getLicenseInstanceId();
  let lastFailure: LicenseResolutionFailure | undefined;

  const envCert = process.env.CANVAS_LICENSE_CERT?.trim();
  if (envCert) {
    const verification = await verifyLicenseJwtDetailed(envCert, instanceId);
    if (verification.ok) {
      const payload = verification.payload;
      const status = statusFromPayload(payload, instanceId, 'env');
      if (status) {
        try {
          await saveLicenseCert(envCert, payload);
          logLicenseInfoThrottled(LOG_PREFIX, 'resolved from env certificate', {
            instanceId,
            plan: payload.plan,
            expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
            managedConfigured: isManagedLicenseConfigured(),
          });
          return status;
        } catch (error) {
          const failure = storageFailure(error, payload, 'env');
          if (!failure) throw error;
          lastFailure = failure;
          console.warn(`${LOG_PREFIX} env certificate rollback rejected`, {
            ...certLogContext(envCert, instanceId),
            code: failure.code,
            managedConfigured: isManagedLicenseConfigured(),
          });
        }
      } else {
        lastFailure = {
          ok: false,
          code: 'LICENSE_CERT_CLAIMS_INVALID',
          payload,
          source: 'env',
        };
        console.warn(`${LOG_PREFIX} env certificate has invalid product claims`, {
          ...certLogContext(envCert, instanceId),
          managedConfigured: isManagedLicenseConfigured(),
        });
      }
    } else {
      lastFailure = { ...verification, source: 'env' };
      console.warn(`${LOG_PREFIX} env certificate was rejected`, {
        ...certLogContext(envCert, instanceId),
        code: verification.code,
        managedConfigured: isManagedLicenseConfigured(),
      });
    }
  }

  const stored = await loadStoredLicenseCert(instanceId);
  if (stored) {
    const verification = await verifyLicenseJwtDetailed(stored, instanceId);
    if (verification.ok) {
      const payload = verification.payload;
      const status = statusFromPayload(payload, instanceId, 'stored');
      if (status) {
        logLicenseInfoThrottled(LOG_PREFIX, 'resolved from stored certificate', {
          instanceId,
          plan: payload.plan,
          expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
          managedConfigured: isManagedLicenseConfigured(),
        });
        return status;
      }
      lastFailure = {
        ok: false,
        code: 'LICENSE_CERT_CLAIMS_INVALID',
        payload,
        source: 'stored',
      };
      console.warn(`${LOG_PREFIX} stored certificate has invalid product claims`, {
        ...certLogContext(stored, instanceId),
        managedConfigured: isManagedLicenseConfigured(),
      });
    } else {
      lastFailure = { ...verification, source: 'stored' };
      console.warn(`${LOG_PREFIX} stored certificate was rejected`, {
        ...certLogContext(stored, instanceId),
        code: verification.code,
        managedConfigured: isManagedLicenseConfigured(),
      });
    }
  }

  const managed = await getManagedLicenseStatus(instanceId);
  if (managed.status) return managed.status;
  if (managed.failure) lastFailure = managed.failure;
  const keyError = lastFailure?.code === 'LICENSE_CERT_PUBLIC_KEY_UNAVAILABLE'
    ? await publicKeyUnavailableError()
    : undefined;
  const status = unresolvedStatus(instanceId, lastFailure, keyError);

  console.warn(`${LOG_PREFIX} unresolved license status`, {
    instanceId,
    error: status.error,
    code: status.code,
    licenseState: status.licenseState,
    managedConfigured: isManagedLicenseConfigured(),
    hasEnvCert: Boolean(envCert),
    hasStoredCert: Boolean(stored),
    controlPlaneHost: getControlPlaneHost(),
  });

  return status;
}

export async function requireLicenseStatus(): Promise<LicenseStatus> {
  return getLicenseStatus();
}

export async function activateLicenseCert(cert: string): Promise<LicenseStatus> {
  const instanceId = getLicenseInstanceId();
  const verification = await verifyLicenseJwtDetailed(cert, instanceId);
  if (!verification.ok) {
    throw new LicenseCertificateValidationError(verification.code);
  }
  const payload = verification.payload;
  const status = statusFromPayload(payload, instanceId, 'stored');
  if (!status) {
    throw new LicenseCertificateValidationError('LICENSE_CERT_CLAIMS_INVALID');
  }
  await saveLicenseCert(cert, payload);
  return status;
}

export function getLicenseControlPlaneUrl(): string {
  return getControlPlaneLicenseBaseUrl();
}
