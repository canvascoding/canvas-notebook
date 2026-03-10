import { openDb } from '../db';

export interface OAuthToken {
  id: string;
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  email?: string;
  createdAt: number;
  updatedAt: number;
}

export async function getValidToken(provider: string): Promise<OAuthToken | null> {
  const db = await openDb();
  try {
    const row = await db.get(
      `SELECT * FROM oauth_tokens 
       WHERE provider = ? 
       AND is_valid = 1 
       ORDER BY updated_at DESC 
       LIMIT 1`,
      [provider]
    );
    
    if (!row) return null;

    // Check if token is expired
    if (row.expires_at && row.expires_at < Date.now()) {
      // Mark as invalid
      await db.run(
        `UPDATE oauth_tokens SET is_valid = 0 WHERE id = ?`,
        [row.id]
      );
      return null;
    }

    return {
      id: row.id,
      provider: row.provider,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      scope: row.scope,
      email: row.email,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } finally {
    await db.close();
  }
}

export async function storeToken(token: OAuthToken): Promise<void> {
  const db = await openDb();
  try {
    await db.run(
      `INSERT INTO oauth_tokens 
       (id, provider, access_token, refresh_token, expires_at, scope, email, created_at, updated_at, is_valid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       email = excluded.email,
       updated_at = excluded.updated_at,
       is_valid = 1`,
      [
        token.id,
        token.provider,
        token.accessToken,
        token.refreshToken || null,
        token.expiresAt || null,
        token.scope || null,
        token.email || null,
        token.createdAt,
        token.updatedAt,
      ]
    );
  } finally {
    await db.close();
  }
}

export async function deleteToken(provider: string): Promise<void> {
  const db = await openDb();
  try {
    await db.run(
      `DELETE FROM oauth_tokens WHERE provider = ?`,
      [provider]
    );
  } finally {
    await db.close();
  }
}
