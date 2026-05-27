import 'server-only';

import crypto from 'crypto';
import type { NextResponse } from 'next/server';
import type { LicenseStatus } from './types';

export const LICENSE_GATE_COOKIE = 'canvas_license_gate';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;

function getCookieSecret(): string {
  return process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET || 'canvas-notebook-local-dev-secret-change-me';
}

function sign(value: string): string {
  return crypto.createHmac('sha256', getCookieSecret()).update(value).digest('base64url');
}

export function buildLicenseGateCookie(status: LicenseStatus): string {
  const expiresAt = Math.min(
    Date.now() + COOKIE_MAX_AGE_SECONDS * 1000,
    status.expiresAt ? new Date(status.expiresAt).getTime() : Date.now() + COOKIE_MAX_AGE_SECONDS * 1000,
  );
  const payload = Buffer.from(JSON.stringify({
    licensed: status.licensed,
    plan: status.plan,
    instanceId: status.instanceId,
    expiresAt,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function setLicenseGateCookie(response: NextResponse, status: LicenseStatus): void {
  if (!status.licensed) {
    response.cookies.delete(LICENSE_GATE_COOKIE);
    return;
  }
  response.cookies.set(LICENSE_GATE_COOKIE, buildLicenseGateCookie(status), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}
