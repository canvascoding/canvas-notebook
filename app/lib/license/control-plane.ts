import 'server-only';

import { activateLicenseCert, getLicenseControlPlaneUrl } from './index';
import { licenseActivationFailureCode } from './error-codes';
import { getLicenseInstanceId } from './instance';
import type { LicenseStatus } from './types';

export class LicenseControlPlaneError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'LicenseControlPlaneError';
  }
}

async function postLicenseControlPlane(
  path: '/v1/license/register' | '/v1/license/activate',
  body: Record<string, unknown>,
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  try {
    const response = await fetch(`${getLicenseControlPlaneUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { response, payload };
  } catch (error) {
    throw new LicenseControlPlaneError(
      error instanceof Error ? error.message : 'The license service is unavailable.',
      503,
      'LICENSE_CONTROL_PLANE_UNREACHABLE',
    );
  }
}

export type CommunityLicenseRegistration = {
  status: string;
  expiresAt: string | null;
};

export async function requestCommunityLicenseRegistration(input: {
  email: string;
  activationUrl: string;
  marketingOptIn: boolean;
}): Promise<CommunityLicenseRegistration> {
  const instanceId = getLicenseInstanceId();
  const { response, payload } = await postLicenseControlPlane('/v1/license/register', {
    email: input.email,
    instanceId,
    activationUrl: input.activationUrl,
    marketingOptIn: input.marketingOptIn,
  });
  if (!response.ok) {
    throw new LicenseControlPlaneError(
      typeof payload.error === 'string' ? payload.error : 'License registration failed.',
      response.status,
      typeof payload.code === 'string' ? payload.code : 'LICENSE_REGISTRATION_FAILED',
    );
  }
  return {
    status: typeof payload.status === 'string' ? payload.status : 'issued',
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
  };
}

export async function activateInstanceLicense(key: string): Promise<LicenseStatus> {
  const instanceId = getLicenseInstanceId();
  const { response, payload } = await postLicenseControlPlane('/v1/license/activate', {
    key,
    instanceId,
  });
  const certificate = typeof payload.license === 'string' ? payload.license : null;
  if (!response.ok || !certificate) {
    const message = typeof payload.error === 'string' ? payload.error : 'License activation failed.';
    throw new LicenseControlPlaneError(
      message,
      response.status || 400,
      typeof payload.code === 'string' ? payload.code : licenseActivationFailureCode(message),
    );
  }
  try {
    return await activateLicenseCert(certificate);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'License activation failed.';
    throw new LicenseControlPlaneError(
      message,
      message.includes('invalid for this instance') ? 400 : 503,
      message.includes('invalid for this instance') ? 'LICENSE_INVALID' : 'LICENSE_CONTROL_PLANE_UNREACHABLE',
    );
  }
}
