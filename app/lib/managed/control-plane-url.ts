import 'server-only';

export function getManagedControlPlaneBaseUrl(): string | null {
  const raw = process.env.CANVAS_CONTROL_PLANE_URL?.trim();
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
