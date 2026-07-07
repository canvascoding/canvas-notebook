import 'server-only';

export function areProjectFeaturesEnabled(): boolean {
  const value = process.env.CANVAS_PROJECT_FEATURES_ENABLED?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
