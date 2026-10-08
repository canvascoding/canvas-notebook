import type { IncomingMessage, ServerResponse } from 'node:http';
import { htmlPreviewOrigins, isHtmlPreviewHost } from '../app/lib/html-preview-origin';

const mcpAppPath = /^\/__preview\/[A-Za-z0-9_-]{43}\/mcp-app\/(?:frame|document)$/u;
const sameOriginPreviewPath = /^\/__document-preview\/[A-Za-z0-9_-]{43}\//u;

/** Preview vhosts never expose the app router or receive its credentials. */
export function handleHtmlPreviewBoundary(request: IncomingMessage, response: ServerResponse): boolean {
  const pathname=new URL(request.url || '/', 'http://localhost').pathname;
  if(isHtmlPreviewHost(request.headers.host)) {
    for(const name of Object.keys(request.headers)) {
      if(['cookie','authorization','proxy-authorization'].includes(name) || name.startsWith('x-canvas-')) delete request.headers[name];
    }
    if(['GET','HEAD'].includes(request.method || '') && /^\/__preview\/[A-Za-z0-9_-]{43}\//u.test(pathname)) return false;
    response.writeHead(404,{'Cache-Control':'no-store'});response.end();return true;
  }
  if (sameOriginPreviewPath.test(pathname)) {
    if (!['GET','HEAD'].includes(request.method || '')) {
      response.writeHead(404,{'Cache-Control':'no-store'});response.end();return true;
    }
    for(const name of Object.keys(request.headers)) {
      if(['cookie','authorization','proxy-authorization'].includes(name) || name.startsWith('x-canvas-')) delete request.headers[name];
    }
    return false;
  }
  // The trusted MCP relay may use the normal app origin. The route handler
  // still validates the configured frame host, ticket, login and ownership.
  if (['GET','HEAD'].includes(request.method || '') && mcpAppPath.test(pathname)) return false;
  if (pathname.startsWith('/__preview/')) {
    response.writeHead(404,{'Cache-Control':'no-store'});response.end();return true;
  }
  const origin=request.headers.origin;
  let previewOrigin: string | undefined;
  try { previewOrigin=htmlPreviewOrigins().previewOrigin; } catch { /* Origin configuration is validated when issuing previews. */ }
  const apiPath=pathname.startsWith('/api/') || pathname.startsWith('/media/');
  const browserCrossOrigin=['cross-site','same-site'].includes(String(request.headers['sec-fetch-site'] || ''));
  // OAuth providers return by cross-origin document navigation, which carries
  // SameSite=Lax cookies. Exact GET callbacks retain their single-use, expiring
  // state validation and existing browser authentication contracts.
  // Keep subresource/iframe requests and untrusted preview origins blocked.
  const callbackQuery = new URL(request.url || '/', 'http://localhost').searchParams;
  const desktopStatus = callbackQuery.get('status');
  const desktopAccount = callbackQuery.get('connected_account_id');
  const desktopError = callbackQuery.get('error');
  const sharedDesktopCallback = pathname === '/api/composio/shared/desktop/callback'
    && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(callbackQuery.get('flow') || '')
    && [...callbackQuery.keys()].every(key => ['flow', 'error', 'status', 'connected_account_id'].includes(key)
      && callbackQuery.getAll(key).length === 1)
    && (desktopStatus === null || ['success', 'failed'].includes(desktopStatus))
    && (desktopError === null || ['access_denied', 'server_error', 'temporarily_unavailable', 'invalid_request',
      'unauthorized_client', 'unsupported_response_type', 'invalid_scope'].includes(desktopError))
    && (desktopAccount === null || (desktopStatus !== null && /^[^\s\x00-\x1f\x7f]{1,256}$/u.test(desktopAccount)))
    && (desktopStatus !== 'success' || (desktopAccount !== null && desktopError === null));
  const composioCallbackNavigation = request.method === 'GET'
    && (pathname === '/api/composio/callback'
      || (pathname === '/api/composio/shared/callback'
        && /^[A-Za-z0-9_-]{43}$/u.test(callbackQuery.get('flow') || ''))
      || sharedDesktopCallback)
    && (!request.headers['sec-fetch-mode'] || request.headers['sec-fetch-mode'] === 'navigate')
    && (!request.headers['sec-fetch-dest'] || request.headers['sec-fetch-dest'] === 'document');
  const mcpCallbackNavigation = request.method === 'GET'
    && ((pathname === '/api/mcp/oauth/callback'
      && /^(?:desktop_)?[A-Za-z0-9_-]{32}$/u.test(new URL(request.url || '/', 'http://localhost').searchParams.get('state') || ''))
      || (pathname === '/api/mcp/shared-connections/oauth/callback'
        && /^[A-Za-z0-9_-]{32}$/u.test(new URL(request.url || '/', 'http://localhost').searchParams.get('state') || '')))
    && (!request.headers['sec-fetch-mode'] || request.headers['sec-fetch-mode'] === 'navigate')
    && (!request.headers['sec-fetch-dest'] || request.headers['sec-fetch-dest'] === 'document');
  const crossOriginCookie=browserCrossOrigin && Boolean(request.headers.cookie)
    && !pathname.startsWith('/api/auth/') && !composioCallbackNavigation && !mcpCallbackNavigation;
  if(apiPath && ((previewOrigin !== undefined && origin === previewOrigin) || origin === 'null' || crossOriginCookie)) {
    response.writeHead(403,{'Cache-Control':'no-store','Content-Type':'application/json'});
    response.end(JSON.stringify({success:false,error:'Cross-origin app access is not allowed'}));return true;
  }
  return false;
}
