import 'server-only';

import { htmlPreviewOrigins } from '@/app/lib/html-preview-origin';

export function isMcpAppsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.CANVAS_MCP_APPS_ENABLED !== 'true') return false;
  try {
    htmlPreviewOrigins(env);
    return true;
  } catch {
    return false;
  }
}
