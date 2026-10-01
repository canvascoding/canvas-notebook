import crypto from 'node:crypto';

/** Adapter-level email ciphertext predates the distinct outer ENV namespace. */
export function isAuthenticatedLegacyEmailEnvelope(value: string, candidates: readonly string[]): boolean {
  const parts = /^enc:v1:([a-f0-9]{24}):([a-f0-9]{32}):((?:[a-f0-9]{2})+)$/u.exec(value);
  if (!parts) return false;
  for (const secret of candidates) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(secret).digest(), Buffer.from(parts[1], 'hex'));
      decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
      const plain = Buffer.concat([decipher.update(Buffer.from(parts[3], 'hex')), decipher.final()]);
      const payload: unknown = JSON.parse(plain.toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const entry = payload as Record<string, unknown>;
      if (entry.authType === 'oauth' && typeof entry.tokenType === 'string' && entry.tokenType.trim()
        && typeof entry.accessToken === 'string' && entry.accessToken.trim()
        && (entry.refreshToken === undefined || typeof entry.refreshToken === 'string')
        && (entry.scope === undefined || typeof entry.scope === 'string')
        && (entry.expiresAt === undefined || typeof entry.expiresAt === 'string' && Number.isFinite(Date.parse(entry.expiresAt)))) return true;
      const validServer = (server: unknown): boolean => {
        if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
        const item = server as Record<string, unknown>;
        return typeof item.host === 'string' && Boolean(item.host.trim())
          && typeof item.port === 'number' && Number.isInteger(item.port) && item.port > 0 && item.port <= 65_535
          && typeof item.secure === 'boolean' && typeof item.username === 'string' && typeof item.password === 'string';
      };
      if (entry.authType === 'smtp_imap' && validServer(entry.smtp) && (entry.imap === undefined || validServer(entry.imap))) return true;
    } catch { /* Only an authenticated, valid adapter payload disambiguates legacy ciphertext. */ }
  }
  return false;
}
