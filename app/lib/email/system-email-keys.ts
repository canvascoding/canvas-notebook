export const SYSTEM_EMAIL_ENV_KEYS = [
  'CANVAS_SYSTEM_SMTP_HOST',
  'CANVAS_SYSTEM_SMTP_PORT',
  'CANVAS_SYSTEM_SMTP_SECURE',
  'CANVAS_SYSTEM_SMTP_USERNAME',
  'CANVAS_SYSTEM_SMTP_PASSWORD',
  'CANVAS_SYSTEM_EMAIL_FROM',
  'CANVAS_SYSTEM_EMAIL_FROM_NAME',
  'CANVAS_SYSTEM_EMAIL_REPLY_TO',
  'CANVAS_SYSTEM_EMAIL_DELIVERY_MODE',
] as const;

const systemEmailEnvKeySet = new Set<string>(SYSTEM_EMAIL_ENV_KEYS);

export function isSystemEmailEnvKey(key: string): boolean {
  return systemEmailEnvKeySet.has(key.trim());
}
