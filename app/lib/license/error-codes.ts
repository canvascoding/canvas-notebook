import type { LicenseStatus } from './types';

export type LicenseApiErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_REQUEST'
  | 'LICENSE_REGISTRATION_FAILED'
  | 'LICENSE_ACTIVATION_FAILED'
  | 'LICENSE_INVALID'
  | 'LICENSE_EXPIRED'
  | 'LICENSE_PUBLIC_KEY_UNAVAILABLE'
  | 'LICENSE_CONTROL_PLANE_UNREACHABLE'
  | 'LICENSE_UNTRUSTED_PUBLIC_KEY';

export function codeFromLicenseError(error?: LicenseStatus['error']): LicenseApiErrorCode | undefined {
  switch (error) {
    case 'license_expired':
      return 'LICENSE_EXPIRED';
    case 'control_plane_unreachable':
      return 'LICENSE_CONTROL_PLANE_UNREACHABLE';
    case 'untrusted_public_key':
      return 'LICENSE_UNTRUSTED_PUBLIC_KEY';
    case 'missing_public_key':
    case 'public_key_unavailable':
      return 'LICENSE_PUBLIC_KEY_UNAVAILABLE';
    default:
      return undefined;
  }
}

export function licenseActivationFailureCode(message: string): LicenseApiErrorCode {
  if (message.toLowerCase().includes('expired')) return 'LICENSE_EXPIRED';
  return 'LICENSE_ACTIVATION_FAILED';
}
