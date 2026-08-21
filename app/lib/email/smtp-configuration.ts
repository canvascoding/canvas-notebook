import 'server-only';

export type SmtpTlsMode = 'implicit_tls' | 'starttls';

export class SmtpConfigurationError extends Error {
  constructor(message: string, readonly code = 'SYSTEM_EMAIL_VALIDATION_FAILED') {
    super(message);
    this.name = 'SmtpConfigurationError';
  }
}

export function normalizeSmtpHost(value: unknown, label = 'SMTP host'): string {
  if (typeof value !== 'string') throw new SmtpConfigurationError(`${label} is required.`);
  const normalized = value.trim();
  if (!normalized) throw new SmtpConfigurationError(`${label} is required.`);
  if (/^[a-z][a-z0-9+.-]*:/iu.test(normalized) || /[/?#\\]/u.test(normalized)) {
    throw new SmtpConfigurationError(`${label} must be a host name or IP address, not a URL.`);
  }
  return normalized;
}

export function normalizeSmtpPort(value: unknown, label = 'SMTP port'): number {
  const normalized = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9]+$/u.test(normalized)) {
    throw new SmtpConfigurationError(`${label} must be a port between 1 and 65535.`);
  }
  const numeric = Number(normalized);
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > 65535) {
    throw new SmtpConfigurationError(`${label} must be a port between 1 and 65535.`);
  }
  return numeric;
}

export function normalizeSmtpBoolean(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new SmtpConfigurationError(`${label} must be true or false.`);
}

export function normalizeSmtpTlsMode(value: unknown, fallback?: unknown): SmtpTlsMode {
  if (value === 'implicit_tls' || value === 'starttls') return value;
  if (value === undefined || value === null || value === '') {
    return normalizeSmtpBoolean(fallback, 'SMTP secure') ? 'implicit_tls' : 'starttls';
  }
  throw new SmtpConfigurationError('SMTP TLS mode must be implicit_tls or starttls.');
}

export function secureFromTlsMode(mode: SmtpTlsMode): boolean {
  return mode === 'implicit_tls';
}

export function normalizeRequiredSmtpString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new SmtpConfigurationError(`${label} is required.`);
  return value.trim();
}

export function normalizeSmtpEmailAddress(value: unknown, label = 'Email address'): string {
  if (typeof value !== 'string') throw new SmtpConfigurationError(`${label} is required.`);
  const normalized = value.trim().toLowerCase();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new SmtpConfigurationError(`${label} must be a valid email address.`);
  }
  return normalized;
}

export function normalizeOptionalSmtpString(value: unknown, label = 'Optional SMTP value'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new SmtpConfigurationError(`${label} must be text.`);
  const normalized = value.trim();
  return normalized || null;
}

export function classifySmtpError(error: unknown): { code: string; status: number } {
  if (error instanceof SmtpConfigurationError) return { code: error.code, status: 400 };
  const value = error && typeof error === 'object' ? error as { code?: unknown; responseCode?: unknown; message?: unknown } : {};
  const code = typeof value.code === 'string' ? value.code.toUpperCase() : '';
  const responseCode = typeof value.responseCode === 'number' ? value.responseCode : 0;
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return { code: 'SMTP_CONNECTION_TIMEOUT', status: 504 };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code: 'SMTP_DNS_FAILED', status: 502 };
  if (code.includes('TLS') || code === 'ESOCKET') return { code: 'SMTP_TLS_FAILED', status: 502 };
  if (responseCode === 535 || /auth|credential|login/iu.test(String(value.message || ''))) return { code: 'SMTP_AUTH_FAILED', status: 422 };
  if (responseCode >= 550 && responseCode < 560) return { code: 'SMTP_SENDER_OR_RECIPIENT_REJECTED', status: 422 };
  if (code === 'ECONNECTION' || code === 'ECONNREFUSED' || code === 'ECONNRESET') return { code: 'SMTP_CONNECTION_FAILED', status: 502 };
  return { code: 'SYSTEM_EMAIL_SEND_FAILED', status: 502 };
}
