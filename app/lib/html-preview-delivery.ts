import 'server-only';

import fs from 'node:fs';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { createReadStream } from '@/app/lib/filesystem/workspace-files';
import { htmlPreviewAssetReader, HTML_PREVIEW_ROUTE_PREFIX, resolveHtmlPreviewTicket } from './html-preview-ticket';
import { htmlPreviewOrigins } from './html-preview-origin';
import { getHtmlPreviewAssetContentType, HTML_PREVIEW_CSP, isHtmlFile } from './html-preview';
import { rewriteHtmlPreviewCss, rewriteHtmlPreviewDocument, rewriteHtmlPreviewScript } from './html-preview-assets';

const privateHeaders = {
  'Cache-Control':'private, no-store, max-age=0', 'Referrer-Policy':'no-referrer',
  'X-Content-Type-Options':'nosniff', 'X-Robots-Tag':'noindex, nofollow, noarchive',
  // The explicit CSP frame-ancestors contract replaces the app's global XFO.
  'X-Frame-Options':'',
};

export function unavailableHtmlPreview() { return new NextResponse(null,{status:404,headers:privateHeaders}); }

/** Identical document/asset delivery for web, mobile and the PDF proxy. */
export async function deliverHtmlPreviewTicket(ticket: string, filePath: string): Promise<Response> {
  const identity=await resolveHtmlPreviewTicket(ticket,filePath);
  if(!identity) return unavailableHtmlPreview();
  try {
    const routePrefix=`${HTML_PREVIEW_ROUTE_PREFIX}/${encodeURIComponent(ticket)}`;
    const contentType=isHtmlFile(filePath) ? 'text/html; charset=utf-8' : getHtmlPreviewAssetContentType(filePath);
    const {appOrigin}=htmlPreviewOrigins();
    const documentCsp=HTML_PREVIEW_CSP.replace("frame-ancestors 'self'",`frame-ancestors 'self' ${appOrigin}`)
      .replace("base-uri 'self'","base-uri 'self' https:");
    const executable=isHtmlFile(filePath) || /\.[cm]?js$/iu.test(filePath);
    const headers={...privateHeaders,'Content-Type':contentType,'Content-Security-Policy':executable
      ? documentCsp + (isHtmlFile(filePath) ? '; sandbox allow-scripts allow-same-origin' : '')
      : `default-src 'none'; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https: http:; font-src 'self' data: https:; frame-ancestors 'self' ${appOrigin}`};
    if(isHtmlFile(filePath) || /\.(?:[cm]?js|css)$/iu.test(filePath)) {
      const source=(await htmlPreviewAssetReader(identity.workspace,identity.userId,identity.kind).read(filePath)).toString('utf8');
      const body=isHtmlFile(filePath) ? rewriteHtmlPreviewDocument(source,filePath,routePrefix)
        : /\.css$/iu.test(filePath) ? rewriteHtmlPreviewCss(source,routePrefix) : rewriteHtmlPreviewScript(source,routePrefix);
      return new NextResponse(body,{headers});
    }
    const stream=identity.absolutePath ? fs.createReadStream(identity.absolutePath)
      : (await createReadStream(filePath,undefined,{workspace:identity.workspace})).stream;
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{headers});
  } catch { return unavailableHtmlPreview(); }
}
