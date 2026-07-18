export function isBrowserLabAllowed(user: {
  role?: string | null;
  email?: string | null;
}): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return user.role === 'admin'
    || Boolean(
      process.env.BOOTSTRAP_ADMIN_EMAIL?.trim()
      && user.email?.trim().toLowerCase() === process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase(),
    );
}
