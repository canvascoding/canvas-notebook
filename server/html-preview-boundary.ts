import type { IncomingMessage, ServerResponse } from 'node:http';
import { htmlPreviewOrigins, isHtmlPreviewHost } from '../app/lib/html-preview-origin';

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
  if (pathname.startsWith('/__preview/')) {
    response.writeHead(404,{'Cache-Control':'no-store'});response.end();return true;
  }
  const origin=request.headers.origin;
  let previewOrigin: string | undefined;
  try { previewOrigin=htmlPreviewOrigins().previewOrigin; } catch { /* Origin configuration is validated when issuing previews. */ }
  const apiPath=pathname.startsWith('/api/') || pathname.startsWith('/media/');
  const browserCrossOrigin=['cross-site','same-site'].includes(String(request.headers['sec-fetch-site'] || ''));
  const crossOriginCookie=browserCrossOrigin && Boolean(request.headers.cookie) && !pathname.startsWith('/api/auth/');
  if(apiPath && ((previewOrigin !== undefined && origin === previewOrigin) || origin === 'null' || crossOriginCookie)) {
    response.writeHead(403,{'Cache-Control':'no-store','Content-Type':'application/json'});
    response.end(JSON.stringify({success:false,error:'Cross-origin app access is not allowed'}));return true;
  }
  return false;
}
