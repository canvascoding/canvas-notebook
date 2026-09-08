import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import type { HTTPRequest } from 'puppeteer-core';

/** Server-created authorization for the transitional internal preview renderer. */
export type PdfPreviewAuthorization = {
  origin: string;
  workspaceId: string;
  kind: 'workspace' | 'studio';
  cookie: string;
};

function isAuthorizedPreviewRequest(url: URL, method: string, authorization: PdfPreviewAuthorization): boolean {
  if (!['GET', 'HEAD'].includes(method) || url.origin !== authorization.origin || url.username || url.password) return false;
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.searchParams.getAll('workspaceId').some(value => value !== authorization.workspaceId)) return false;
  try {
    // Reject encoded separators/traversal, including a second decoding by a
    // catch-all route. WHATWG URL normalization already removes plain dot paths.
    for (const part of url.pathname.split('/')) {
      const decoded = decodeURIComponent(part);
      if (decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f]|%(?:2e|2f|5c)/iu.test(decoded)) return false;
    }
  } catch { return false; }
  const prefix = authorization.kind === 'workspace'
    ? `/api/media/preview/__workspace/${encodeURIComponent(authorization.workspaceId)}/`
    : '/api/studio/media/preview/';
  return url.pathname.startsWith(prefix);
}

/** Recomputed for every request/redirect; credentials never enter a cookie jar. */
export function pdfPreviewRequestHeaders(
  requestUrl: string,
  method: string,
  original: Record<string, string>,
  authorization?: PdfPreviewAuthorization,
): Record<string, string> {
  const headers = Object.fromEntries(Object.entries(original).filter(([key]) => {
    const name = key.toLowerCase();
    return !['cookie', 'authorization', 'proxy-authorization', 'referer'].includes(name) && !name.startsWith('x-canvas-');
  }));
  if (!authorization) return headers;
  try {
    if (isAuthorizedPreviewRequest(new URL(requestUrl), method, authorization)) {
      headers.cookie = authorization.cookie;
      headers[WORKSPACE_ID_HEADER] = authorization.workspaceId;
    }
  } catch { /* Invalid destinations never receive credentials. */ }
  return headers;
}

/** Keep session refresh cookies out of Chromium as well as outbound headers. */
export async function handlePdfPreviewRequest(
  request: HTTPRequest,
  authorization: PdfPreviewAuthorization | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (request.isInterceptResolutionHandled()) return;
  try {
    const headers = pdfPreviewRequestHeaders(request.url(), request.method(), request.headers(), authorization);
    if (!authorization || headers.cookie !== authorization.cookie) {
      await request.continue({ headers });
      return;
    }
    // Fetch only the fixed internal read scope outside the browser. Inserting
    // a Cookie through CDP would let a refreshed Set-Cookie populate Chromium's
    // jar and authorize unrelated API/worker requests inside this same job.
    const response = await fetch(request.url(), {
      method: request.method(),
      headers: {
        cookie: authorization.cookie,
        [WORKSPACE_ID_HEADER]: authorization.workspaceId,
        accept: headers.accept || '*/*',
        'accept-encoding': 'identity',
        ...(headers.range ? { range: headers.range } : {}),
      },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const responseHeaders = Object.fromEntries([...response.headers].filter(([name]) => ![
      'set-cookie', 'content-length', 'content-encoding', 'connection', 'transfer-encoding',
      'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'trailer', 'upgrade',
    ].includes(name)));
    responseHeaders['referrer-policy'] = 'no-referrer';
    const body = Buffer.from(await response.arrayBuffer());
    if (!request.isInterceptResolutionHandled()) await request.respond({ status: response.status, headers: responseHeaders, body });
  } catch {
    if (!request.isInterceptResolutionHandled()) await request.abort().catch(() => undefined);
  }
}
