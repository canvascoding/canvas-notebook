import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { resolveSkillsTokenPath } from '@/app/lib/runtime-data-paths';

async function resolveInternalAutomationToken(): Promise<string> {
  const envToken = process.env.CANVAS_SKILLS_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  try {
    return (await fs.readFile(resolveSkillsTokenPath(), 'utf8')).trim();
  } catch {
    return '';
  }
}

function safeTokenMatch(expected: string, provided: string): boolean {
  if (!expected || !provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export async function requireInternalAutomationToken(request: NextRequest) {
  const expectedToken = await resolveInternalAutomationToken();
  const providedToken = request.headers.get('x-canvas-internal-token')?.trim() || '';

  if (!safeTokenMatch(expectedToken, providedToken)) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return { ok: true, response: null };
}

export async function requireAutomationSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return {
    session,
    response: null,
  };
}

export function applyAutomationRateLimit(
  request: NextRequest,
  keyPrefix: string,
  limit = 60,
  windowMs = 60_000,
) {
  return rateLimit(request, {
    limit,
    windowMs,
    keyPrefix,
  });
}
