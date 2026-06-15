import 'server-only';

export const DEFAULT_MANAGED_CONTROL_PLANE_URL = 'https://api.canvasnotebook.app';

export function getManagedControlPlaneBaseUrl(): string | null {
  const configured =
    process.env.CANVAS_CONTROL_PLANE_URL ||
    process.env.NEXT_PUBLIC_CANVAS_CONTROL_PLANE_URL;
  const raw = configured?.trim() || (
    process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' || process.env.CANVAS_INSTANCE_TOKEN?.trim()
      ? DEFAULT_MANAGED_CONTROL_PLANE_URL
      : ''
  );
  if (!raw) return null;
  const normalized = raw.replace(/^ws/i, 'http').replace(/\/+$/, '');
  try {
    const parsed = new URL(normalized);
    if (parsed.pathname === '/agent') {
      parsed.pathname = '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return normalized.replace(/\/agent$/, '');
  }
}
