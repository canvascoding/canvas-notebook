import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  getUserPreferences,
  normalizeUserLastActiveAgentId,
  normalizeUserLocale,
  setUserPreferredLocale,
  updateUserPreferences,
  type UserPreferences,
} from '@/app/lib/user-preferences';
import { getAgentProfile } from '@/app/lib/agents/registry';

function jsonWithRequestId(requestId: string, body: Record<string, unknown>, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-Request-Id', requestId);
  return NextResponse.json(body, { ...init, headers });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function GET(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      console.warn('[user-preferences] GET unauthorized', { requestId });
      return jsonWithRequestId(requestId, { success: false, error: 'Unauthorized', requestId }, { status: 401 });
    }

    const preferences = await getUserPreferences(session.user.id);
    console.log('[user-preferences] GET success', { requestId, userId: session.user.id });
    return jsonWithRequestId(requestId, { success: true, data: preferences });
  } catch (error) {
    console.error('[user-preferences] GET failed', { requestId, error });
    return jsonWithRequestId(
      requestId,
      { success: false, error: errorMessage(error, 'Failed to read user preferences.'), requestId },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const requestId = randomUUID();
  let logUser: { userId?: string; email?: string | null } = {};

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      console.warn('[user-preferences] PATCH unauthorized', { requestId });
      return jsonWithRequestId(requestId, { success: false, error: 'Unauthorized', requestId }, { status: 401 });
    }

    logUser = {
      userId: session.user.id,
      email: session.user.email,
    };

    const payload = await request.json().catch(() => null);
    const payloadKeys = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload)
      : [];
    console.log('[user-preferences] PATCH received', { requestId, ...logUser, payloadKeys });

    const updates: UserPreferences = {};

    if (payload && typeof payload === 'object' && 'locale' in payload) {
      const locale = normalizeUserLocale(payload.locale);
      if (!locale) {
        console.warn('[user-preferences] PATCH bad request: unsupported locale', { requestId, ...logUser, locale: payload.locale });
        return jsonWithRequestId(requestId, { success: false, error: 'Unsupported locale.', requestId }, { status: 400 });
      }
      updates.locale = locale;
    }

    if (payload && typeof payload === 'object' && 'emailAllowRemoteImages' in payload) {
      if (typeof payload.emailAllowRemoteImages !== 'boolean') {
        console.warn('[user-preferences] PATCH bad request: unsupported email remote image setting', { requestId, ...logUser });
        return jsonWithRequestId(
          requestId,
          { success: false, error: 'Unsupported email remote image setting.', requestId },
          { status: 400 },
        );
      }
      updates.emailAllowRemoteImages = payload.emailAllowRemoteImages;
    }

    if (payload && typeof payload === 'object' && 'emailRemoteImageAllowedSenders' in payload) {
      if (!Array.isArray(payload.emailRemoteImageAllowedSenders)) {
        console.warn('[user-preferences] PATCH bad request: unsupported email remote image sender setting', { requestId, ...logUser });
        return jsonWithRequestId(
          requestId,
          { success: false, error: 'Unsupported email remote image sender setting.', requestId },
          { status: 400 },
        );
      }
      updates.emailRemoteImageAllowedSenders = payload.emailRemoteImageAllowedSenders;
    }

    if (payload && typeof payload === 'object' && 'lastActiveAgentId' in payload) {
      const lastActiveAgentId = normalizeUserLastActiveAgentId(payload.lastActiveAgentId);
      if (!lastActiveAgentId) {
        console.warn('[user-preferences] PATCH bad request: unsupported agent ID', { requestId, ...logUser });
        return jsonWithRequestId(requestId, { success: false, error: 'Unsupported agent ID.', requestId }, { status: 400 });
      }
      const agent = await getAgentProfile(lastActiveAgentId);
      if (!agent) {
        console.warn('[user-preferences] PATCH bad request: agent not found', { requestId, ...logUser, lastActiveAgentId });
        return jsonWithRequestId(requestId, { success: false, error: 'Agent not found.', requestId }, { status: 404 });
      }
      updates.lastActiveAgentId = lastActiveAgentId;
    }

    const updateKeys = Object.keys(updates);
    if (updateKeys.length === 0) {
      console.warn('[user-preferences] PATCH bad request: no supported update', { requestId, ...logUser, payloadKeys });
      return jsonWithRequestId(
        requestId,
        { success: false, error: 'No supported preference update provided.', requestId },
        { status: 400 },
      );
    }

    const preferences = 'locale' in updates && updateKeys.length === 1
      ? await setUserPreferredLocale(session.user.id, updates.locale)
      : await updateUserPreferences(session.user.id, updates);
    console.log('[user-preferences] PATCH success', { requestId, ...logUser, updateKeys });
    return jsonWithRequestId(requestId, { success: true, data: preferences });
  } catch (error) {
    console.error('[user-preferences] PATCH failed', { requestId, ...logUser, error });
    return jsonWithRequestId(
      requestId,
      { success: false, error: errorMessage(error, 'Failed to update user preferences.'), requestId },
      { status: 500 },
    );
  }
}
