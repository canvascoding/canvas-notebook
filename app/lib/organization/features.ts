export function areExternalUsersEnabled(): boolean {
  const value = process.env.CANVAS_EXTERNAL_USERS_ENABLED?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
