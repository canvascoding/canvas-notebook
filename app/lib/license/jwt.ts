import 'server-only';

import crypto from 'crypto';
import { getExpectedLicenseRuntimeEnvironment } from '@/app/lib/server-settings';
import {
  resolveLicensePublicKeys,
  type LicensePublicKeySet,
} from './public-key';
import {
  normalizeLicenseProductClaims,
  type LicenseCert,
  type LicenseValidationErrorCode,
} from './types';

const LICENSE_ISSUER = 'canvas-control-plane';
const LICENSE_AUDIENCE = 'canvas-notebook';
const DEFAULT_TEST_LICENSE_AUDIENCE = 'canvas-notebook-test';
const MAX_IAT_SKEW_MS = 5 * 60 * 1000;

type LicenseJwtHeader = {
  alg?: string;
  typ?: string;
  kid?: string;
};

export type LicenseVerificationResult =
  | {
      ok: true;
      payload: LicenseCert;
      header: LicenseJwtHeader;
    }
  | {
      ok: false;
      code: LicenseValidationErrorCode;
      payload?: LicenseCert;
    };

const LICENSE_VALIDATION_MESSAGES: Record<LicenseValidationErrorCode, string> = {
  LICENSE_CERT_MALFORMED: 'License certificate is malformed.',
  LICENSE_CERT_ALGORITHM_INVALID: 'License certificate uses an unsupported signing algorithm.',
  LICENSE_CERT_KEY_ID_MISSING: 'License certificate is missing its signing key ID.',
  LICENSE_CERT_KEY_ID_UNKNOWN: 'License certificate references an unknown signing key.',
  LICENSE_CERT_SIGNATURE_INVALID: 'License certificate signature is invalid.',
  LICENSE_CERT_ISSUER_INVALID: 'License certificate issuer is invalid.',
  LICENSE_CERT_AUDIENCE_INVALID: 'License certificate audience is invalid.',
  LICENSE_CERT_INSTANCE_MISMATCH: 'License certificate belongs to another instance.',
  LICENSE_CERT_STATUS_INVALID: 'License certificate is not active.',
  LICENSE_CERT_NOT_YET_VALID: 'License certificate is not valid yet.',
  LICENSE_CERT_EXPIRED: 'License certificate has expired.',
  LICENSE_CERT_PLAN_INVALID: 'License certificate plan is invalid.',
  LICENSE_CERT_CLAIMS_INVALID: 'License certificate contains invalid product claims.',
  LICENSE_CERT_ENVIRONMENT_INVALID: 'License certificate is not allowed in this runtime environment.',
  LICENSE_CERT_PUBLIC_KEY_UNAVAILABLE: 'License certificate signing key is unavailable.',
  LICENSE_CERT_ROLLBACK: 'License certificate would roll back a newer entitlement state.',
};

export class LicenseCertificateValidationError extends Error {
  constructor(
    public readonly code: LicenseValidationErrorCode,
    message = LICENSE_VALIDATION_MESSAGES[code],
  ) {
    super(message);
    this.name = 'LicenseCertificateValidationError';
  }
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function decodeJsonObject<T>(value: string): T | null {
  try {
    const parsed = JSON.parse(base64UrlDecode(value).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

function failure(
  code: LicenseValidationErrorCode,
  payload?: LicenseCert,
): LicenseVerificationResult {
  return payload ? { ok: false, code, payload } : { ok: false, code };
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validEntitlementsVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function expectedAudience(payload: LicenseCert): string | null {
  if (payload.licenseClass !== 'test') return LICENSE_AUDIENCE;
  const audience = process.env.CANVAS_LICENSE_TEST_AUDIENCE?.trim()
    || DEFAULT_TEST_LICENSE_AUDIENCE;
  return audience && audience !== LICENSE_AUDIENCE ? audience : null;
}

function keysetForPayload(payload: LicenseCert): LicensePublicKeySet {
  return payload.licenseClass === 'test' ? 'test' : 'production';
}

function runtimeEnvironmentAccepts(payload: LicenseCert): boolean {
  const expected = getExpectedLicenseRuntimeEnvironment();
  if (!expected || payload.licenseEnvironment !== expected) return false;
  return payload.licenseClass !== 'test' || expected !== 'production';
}

function modernClaimsAreConsistent(payload: LicenseCert): boolean {
  const product = normalizeLicenseProductClaims(payload);
  if (!product || product.protocolVersion === 'legacy') return false;
  if (!nonEmptyString(payload.licenseId) || payload.instanceId !== payload.sub) return false;
  if (!validEntitlementsVersion(payload.entitlementsVersion)) return false;
  if (product.hostingMode === 'community' && payload.plan !== 'community') return false;
  if (product.hostingMode === 'cloud' && payload.plan !== 'managed') return false;
  if (product.edition === 'solo' && product.seatLimit !== 1) return false;
  if (payload.licenseClass === 'commercial') {
    return payload.nonBillable === false
      && payload.grantId === undefined
      && payload.provider !== 'manual'
      && payload.provider !== 'test';
  }
  if (payload.licenseClass === 'manual') {
    return payload.nonBillable === true
      && nonEmptyString(payload.grantId)
      && payload.provider === 'manual';
  }
  return payload.nonBillable === true
    && nonEmptyString(payload.grantId)
    && payload.provider === 'test';
}

export function decodeLicenseJwt(token: string): LicenseCert | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  return decodeJsonObject<LicenseCert>(parts[1]);
}

export async function verifyLicenseJwtDetailed(
  token: string,
  expectedInstanceId: string,
  options: { nowMs?: number } = {},
): Promise<LicenseVerificationResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return failure('LICENSE_CERT_MALFORMED');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonObject<LicenseJwtHeader>(encodedHeader);
  const payload = decodeJsonObject<LicenseCert>(encodedPayload);
  if (!header || !payload) return failure('LICENSE_CERT_MALFORMED');
  if (header.alg !== 'RS256' || (header.typ !== undefined && header.typ !== 'JWT')) {
    return failure('LICENSE_CERT_ALGORITHM_INVALID');
  }

  const product = normalizeLicenseProductClaims(payload);
  const declaresModernProtocol = payload.protocolVersion !== undefined;
  if (declaresModernProtocol && !nonEmptyString(header.kid)) {
    return failure('LICENSE_CERT_KEY_ID_MISSING', payload);
  }
  if (
    product
    && (
      declaresModernProtocol
      || payload.licenseClass === 'manual'
      || payload.licenseClass === 'test'
      || payload.licenseEnvironment !== undefined
    )
    && !runtimeEnvironmentAccepts(payload)
  ) {
    return failure('LICENSE_CERT_ENVIRONMENT_INVALID', payload);
  }
  if (
    !declaresModernProtocol
    && (payload.licenseClass === 'manual' || payload.licenseClass === 'test')
  ) {
    return failure('LICENSE_CERT_CLAIMS_INVALID', payload);
  }

  const keyset = keysetForPayload(payload);
  let resolution = await resolveLicensePublicKeys({ keyset });
  if (resolution.keys.length === 0) {
    return failure('LICENSE_CERT_PUBLIC_KEY_UNAVAILABLE', payload);
  }
  let candidateKeys = nonEmptyString(header.kid)
    ? resolution.keys.filter((key) => key.kid === header.kid)
    : resolution.keys;
  if (candidateKeys.length === 0 && nonEmptyString(header.kid)) {
    resolution = await resolveLicensePublicKeys({ keyset, forceRefresh: true });
    candidateKeys = resolution.keys.filter((key) => key.kid === header.kid);
  }
  if (candidateKeys.length === 0) {
    return failure('LICENSE_CERT_KEY_ID_UNKNOWN', payload);
  }

  const signed = `${encodedHeader}.${encodedPayload}`;
  let signature: Buffer;
  try {
    signature = base64UrlDecode(encodedSignature);
  } catch {
    return failure('LICENSE_CERT_MALFORMED');
  }
  const signatureValid = candidateKeys.some((publicKey) => {
    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(signed);
      verifier.end();
      return verifier.verify(publicKey.publicKey, signature);
    } catch {
      return false;
    }
  });
  if (!signatureValid) return failure('LICENSE_CERT_SIGNATURE_INVALID', payload);

  if (payload.iss !== LICENSE_ISSUER) return failure('LICENSE_CERT_ISSUER_INVALID', payload);
  const audience = expectedAudience(payload);
  if (!audience || payload.aud !== audience) {
    return failure('LICENSE_CERT_AUDIENCE_INVALID', payload);
  }
  if (
    payload.sub !== expectedInstanceId
    || (payload.instanceId !== undefined && payload.instanceId !== expectedInstanceId)
  ) {
    return failure('LICENSE_CERT_INSTANCE_MISMATCH', payload);
  }
  if (payload.status !== 'active') return failure('LICENSE_CERT_STATUS_INVALID', payload);
  if (!['community', 'pro', 'managed'].includes(payload.plan)) {
    return failure('LICENSE_CERT_PLAN_INVALID', payload);
  }
  if (!product) return failure('LICENSE_CERT_CLAIMS_INVALID', payload);
  if (declaresModernProtocol && !modernClaimsAreConsistent(payload)) {
    return failure('LICENSE_CERT_CLAIMS_INVALID', payload);
  }
  if (
    payload.entitlementsVersion !== undefined
    && !validEntitlementsVersion(payload.entitlementsVersion)
  ) {
    return failure('LICENSE_CERT_CLAIMS_INVALID', payload);
  }
  if (payload.iat !== undefined && !validTimestamp(payload.iat)) {
    return failure('LICENSE_CERT_CLAIMS_INVALID', payload);
  }
  if (!validTimestamp(payload.exp)) return failure('LICENSE_CERT_CLAIMS_INVALID', payload);

  const nowMs = options.nowMs ?? Date.now();
  if (payload.iat && payload.iat * 1000 > nowMs + MAX_IAT_SKEW_MS) {
    return failure('LICENSE_CERT_NOT_YET_VALID', payload);
  }
  if (payload.exp * 1000 <= nowMs) return failure('LICENSE_CERT_EXPIRED', payload);

  return { ok: true, payload, header };
}

export async function verifyLicenseJwt(token: string, expectedInstanceId: string): Promise<LicenseCert | null> {
  const result = await verifyLicenseJwtDetailed(token, expectedInstanceId);
  return result.ok ? result.payload : null;
}
