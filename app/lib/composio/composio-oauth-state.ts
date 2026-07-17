import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { openDb } from '@/app/lib/db';
import type { ResolvedComposioContext } from './composio-context';
import { ComposioProfileError } from './composio-profiles';

const OAUTH_FLOW_TTL_MS = 15 * 60_000;
const CONSUMED_STATE_RETENTION_MS = 60 * 60_000;

type OAuthFlowRow = {
  state_hash: string;
  user_id: string;
  workspace_id: string;
  profile_id: string;
  composio_user_id: string;
  toolkit_slug: string;
  return_path: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
};

export interface ComposioOAuthFlowState {
  userId: string;
  workspaceId: string;
  profileId: string;
  composioUserId: string;
  toolkitSlug: string;
  returnPath: string;
  expiresAt: Date;
  consumedAt: Date;
}

function hashState(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function appBaseUrl(): string {
  const configured = process.env.BASE_URL || process.env.APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return `http://localhost:${process.env.PORT || '3000'}`;
}

function normalizeToolkitSlug(value: string): string {
  const toolkit = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(toolkit)) {
    throw new ComposioProfileError('COMPOSIO_TOOLKIT_INVALID', 'The toolkit slug is invalid.');
  }
  return toolkit;
}

function buildReturnPath(context: ResolvedComposioContext, toolkitSlug: string): string {
  const query = new URLSearchParams({
    tab: 'integrations',
    connected: toolkitSlug,
    workspaceId: context.workspaceId,
    composioProfile: context.profileId,
  });
  return `/settings?${query.toString()}`;
}

export async function createComposioOAuthFlowState(input: {
  context: ResolvedComposioContext;
  toolkitSlug: string;
}): Promise<{ state: string; callbackUrl: string; returnPath: string; expiresAt: Date }> {
  const toolkitSlug = normalizeToolkitSlug(input.toolkitSlug);
  const state = randomBytes(32).toString('base64url');
  const stateHash = hashState(state);
  const now = Date.now();
  const expiresAt = new Date(now + OAUTH_FLOW_TTL_MS);
  const returnPath = buildReturnPath(input.context, toolkitSlug);
  const database = await openDb();
  try {
    await database.run(`
      DELETE FROM composio_oauth_flow_states
      WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)
    `, [now, now - CONSUMED_STATE_RETENTION_MS]);
    await database.run(`
      INSERT INTO composio_oauth_flow_states (
        state_hash, user_id, workspace_id, profile_id, composio_user_id,
        toolkit_slug, return_path, expires_at, consumed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `, [
      stateHash,
      input.context.userId,
      input.context.workspaceId,
      input.context.profileId,
      input.context.composioUserId,
      toolkitSlug,
      returnPath,
      expiresAt.getTime(),
      now,
    ]);
  } finally {
    await database.close();
  }

  const callback = new URL('/api/composio/callback', appBaseUrl());
  callback.searchParams.set('flow', state);
  return { state, callbackUrl: callback.toString(), returnPath, expiresAt };
}

export async function consumeComposioOAuthFlowState(input: {
  state: string;
  userId: string;
}): Promise<ComposioOAuthFlowState> {
  const state = input.state.trim();
  const userId = input.userId.trim();
  if (!state || !userId) {
    throw new ComposioProfileError('COMPOSIO_OAUTH_STATE_REQUIRED', 'The Composio connection flow is invalid.', 400);
  }

  const database = await openDb();
  try {
    const now = Date.now();
    const row = await database.get(`
      SELECT
        flow.state_hash,
        flow.user_id,
        flow.workspace_id,
        flow.profile_id,
        flow.composio_user_id,
        flow.toolkit_slug,
        flow.return_path,
        flow.expires_at,
        flow.consumed_at,
        flow.created_at
      FROM composio_oauth_flow_states flow
      INNER JOIN composio_connection_profiles profile
        ON profile.id = flow.profile_id
       AND profile.owner_user_id = flow.user_id
       AND profile.composio_user_id = flow.composio_user_id
       AND profile.status = 'active'
      WHERE flow.state_hash = ? AND flow.user_id = ?
      LIMIT 1
    `, [hashState(state), userId]) as OAuthFlowRow | undefined;

    if (!row || row.consumed_at !== null || row.expires_at < now) {
      throw new ComposioProfileError(
        'COMPOSIO_OAUTH_STATE_INVALID',
        'The Composio connection flow has expired or was already used.',
        409,
      );
    }

    const result = await database.run(`
      UPDATE composio_oauth_flow_states
      SET consumed_at = ?
      WHERE state_hash = ? AND user_id = ? AND consumed_at IS NULL AND expires_at >= ?
    `, [now, row.state_hash, userId, now]) as { changes?: number };
    if (Number(result?.changes || 0) !== 1) {
      throw new ComposioProfileError(
        'COMPOSIO_OAUTH_STATE_INVALID',
        'The Composio connection flow has expired or was already used.',
        409,
      );
    }

    return {
      userId: row.user_id,
      workspaceId: row.workspace_id,
      profileId: row.profile_id,
      composioUserId: row.composio_user_id,
      toolkitSlug: row.toolkit_slug,
      returnPath: row.return_path,
      expiresAt: new Date(row.expires_at),
      consumedAt: new Date(now),
    };
  } finally {
    await database.close();
  }
}
