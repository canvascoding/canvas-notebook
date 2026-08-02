import 'server-only';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_LICENSE_CONTROL_PLANE_URL = 'https://api.canvasnotebook.app';
const DEFAULT_LICENSE_CONTROL_PLANE_WEB_URL = 'https://canvasnotebook.app';

function getDataDir(): string {
  return process.env.DATA || path.resolve(process.cwd(), 'data');
}

export function getLicenseInstanceId(): string {
  const envId = process.env.CANVAS_INSTANCE_ID?.trim();
  if (envId) return envId;

  const instancePath = path.join(getDataDir(), 'instance-id');
  if (existsSync(instancePath)) {
    const stored = readFileSync(instancePath, 'utf8').trim();
    if (stored) return stored;
  }

  const generated = `self_${crypto.randomUUID()}`;
  mkdirSync(path.dirname(instancePath), { recursive: true });
  writeFileSync(instancePath, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  return generated;
}

export function getControlPlaneLicenseBaseUrl(): string {
  const configured =
    process.env.CANVAS_LICENSE_CONTROL_PLANE_URL ||
    process.env.CANVAS_CONTROL_PLANE_URL ||
    process.env.NEXT_PUBLIC_CANVAS_CONTROL_PLANE_URL;
  const trimmed = configured?.trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_LICENSE_CONTROL_PLANE_URL;
}

export function getControlPlaneLicenseWebUrl(): string {
  const configured =
    process.env.CANVAS_LICENSE_CONTROL_PLANE_WEB_URL ||
    process.env.CANVAS_CONTROL_PLANE_WEB_URL;
  const trimmed = configured?.trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_LICENSE_CONTROL_PLANE_WEB_URL;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return DEFAULT_LICENSE_CONTROL_PLANE_WEB_URL;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_LICENSE_CONTROL_PLANE_WEB_URL;
  }
}

export function getCommunityTeamManagementUrl(): string {
  const url = new URL('/dashboard/billing', getControlPlaneLicenseWebUrl());
  url.searchParams.set('intent', 'community-team-upgrade');
  return url.toString();
}

export function getCommunityTeamSeatApprovalUrl(quoteId: string): string {
  const url = new URL('/dashboard/billing', getControlPlaneLicenseWebUrl());
  url.searchParams.set('teamSeatQuote', quoteId);
  return url.toString();
}

export function getRequestOrigin(request: Request): string {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedHost) {
    return `${forwardedProto || 'https'}://${forwardedHost}`;
  }
  const url = new URL(request.url);
  return url.origin;
}
