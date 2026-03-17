export const BOOTSTRAP_SIGNUP_ENV = 'CANVAS_ALLOW_BOOTSTRAP_SIGNUP';

function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

export function getBootstrapAdminEmail(): string | null {
  return normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
}

export function getBootstrapAdminConfig(): {
  email: string;
  password: string;
  name: string;
} | null {
  const email = getBootstrapAdminEmail();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Administrator';

  if (!email || !password) {
    return null;
  }

  return {
    email,
    password,
    name,
  };
}

export function isBootstrapAdminEmail(email: string | null | undefined): boolean {
  const bootstrapEmail = getBootstrapAdminEmail();
  const normalizedEmail = normalizeEmail(email);

  return Boolean(bootstrapEmail && normalizedEmail && bootstrapEmail === normalizedEmail);
}
