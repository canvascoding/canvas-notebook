'use client';

import { AlertTriangle, KeyRound, ShieldAlert } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import type { LicenseStatus } from '@/app/lib/license/types';

export function LicenseBanner({ status }: { status: LicenseStatus }) {
  const isControlPlaneUnreachable = status.error === 'control_plane_unreachable';
  const isPublicKeyUnavailable = status.error === 'public_key_unavailable';
  const isUntrustedPublicKey = status.error === 'untrusted_public_key';
  const isExpired = status.error === 'license_expired';

  const message = isExpired
    ? 'License expired. Please renew or activate a new license.'
    : isUntrustedPublicKey
      ? 'License verification rejected an untrusted public key. Check the configured trusted fingerprint.'
      : isControlPlaneUnreachable
        ? 'Could not reach the license server. Agent and chat features remain locked until verification is restored.'
        : isPublicKeyUnavailable
          ? 'License verification is unavailable. Configure the license public key or check the Control Plane connection.'
          : 'License activation required.';

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2">
      <div className="mx-auto flex max-w-7xl items-center gap-3 text-sm">
        {isControlPlaneUnreachable ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
        ) : (
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
        )}
        <span className="min-w-0 flex-1 text-foreground">{message}</span>
        <Link
          href="/settings?tab=license"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-700"
        >
          <KeyRound className="h-3 w-3" />
          Activate
        </Link>
      </div>
    </div>
  );
}
