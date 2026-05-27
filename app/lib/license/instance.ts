import 'server-only';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_LICENSE_CONTROL_PLANE_URL = 'https://api.canvas.holdings';

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

export function getRequestOrigin(request: Request): string {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedHost) {
    return `${forwardedProto || 'https'}://${forwardedHost}`;
  }
  const url = new URL(request.url);
  return url.origin;
}
