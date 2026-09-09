import 'server-only';

import { canvasAppOrigin, htmlPreviewOrigins } from '@/app/lib/html-preview-origin';

type McpAppsEnvironment = Record<string, string | undefined>;

/**
 * MCP Apps use the normal Canvas origin by default. The fixed Canvas relay then
 * places provider HTML in a nested opaque-origin sandbox. Operators that have
 * already provisioned an explicit preview origin retain that extra boundary.
 */
export function mcpAppOrigins(env: McpAppsEnvironment = process.env) {
  const appOrigin = canvasAppOrigin(env);
  const frameOrigin = env.CANVAS_HTML_PREVIEW_ORIGIN?.trim()
    ? htmlPreviewOrigins(env).previewOrigin
    : appOrigin;
  return { appOrigin, frameOrigin };
}

export function isMcpAppFrameHost(host: string | null | undefined, env: McpAppsEnvironment = process.env): boolean {
  if (!host || /[\s/@\\?#]/u.test(host)) return false;
  try {
    const frame = new URL(mcpAppOrigins(env).frameOrigin);
    return new URL(`${frame.protocol}//${host}`).host === frame.host;
  } catch {
    return false;
  }
}

export function isMcpAppsEnabled(env: McpAppsEnvironment = process.env): boolean {
  if (env.CANVAS_MCP_APPS_ENABLED?.trim().toLowerCase() === 'false') return false;
  try {
    mcpAppOrigins(env);
    return true;
  } catch {
    return false;
  }
}
