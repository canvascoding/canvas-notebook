import 'server-only';

import fs from 'node:fs';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { createReadStream } from '@/app/lib/filesystem/workspace-files';
import {
  htmlPreviewAssetReader,
  HTML_PREVIEW_ROUTE_PREFIX,
  resolveHtmlPreviewTicket,
  SAME_ORIGIN_HTML_PREVIEW_ROUTE_PREFIX,
} from './html-preview-ticket';
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

type HtmlPreviewDeliveryOptions = {
  sameOrigin?: boolean;
};

/** Identical document/asset delivery for web, mobile and the PDF proxy. */
export async function deliverHtmlPreviewTicket(
  ticket: string,
  filePath: string,
  options: HtmlPreviewDeliveryOptions = {},
): Promise<Response> {
  const identity=await resolveHtmlPreviewTicket(ticket,filePath);
  if(!identity) return unavailableHtmlPreview();
  try {
    const routePrefix=`${options.sameOrigin ? SAME_ORIGIN_HTML_PREVIEW_ROUTE_PREFIX : HTML_PREVIEW_ROUTE_PREFIX}/${encodeURIComponent(ticket)}`;
    const contentType=isHtmlFile(filePath) ? 'text/html; charset=utf-8' : getHtmlPreviewAssetContentType(filePath);
    const {appOrigin}=options.sameOrigin ? {appOrigin:null} : htmlPreviewOrigins();
    const documentCsp=(appOrigin
      ? HTML_PREVIEW_CSP.replace("frame-ancestors 'self'",`frame-ancestors 'self' ${appOrigin}`)
      : HTML_PREVIEW_CSP
    ).replace("base-uri 'self'","base-uri 'self' https:");
    const executable=isHtmlFile(filePath) || /\.[cm]?js$/iu.test(filePath);
    const assetCsp=appOrigin
      ? `default-src 'none'; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https: http:; font-src 'self' data: https:; frame-ancestors 'self' ${appOrigin}`
      : "default-src 'none'; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https: http:; font-src 'self' data: https:; frame-ancestors 'self'";
    const headers: Record<string,string>={...privateHeaders,'Content-Type':contentType,'Content-Security-Policy':executable
      ? documentCsp + (isHtmlFile(filePath) ? `; sandbox allow-scripts${options.sameOrigin ? '' : ' allow-same-origin'}` : '')
      : assetCsp};
    if (options.sameOrigin) {
      headers['Access-Control-Allow-Origin']='null';
      headers.Vary='Origin';
    }
    if(isHtmlFile(filePath) || /\.(?:[cm]?js|css)$/iu.test(filePath)) {
      const source=(await htmlPreviewAssetReader(identity.workspace,identity.userId,identity.kind).read(filePath)).toString('utf8');
      const body=isHtmlFile(filePath) ? rewriteHtmlPreviewDocument(source,filePath,routePrefix,{opaqueOrigin:options.sameOrigin})
        : /\.css$/iu.test(filePath) ? rewriteHtmlPreviewCss(source,routePrefix) : rewriteHtmlPreviewScript(source,routePrefix,filePath);
      return new NextResponse(body,{headers});
    }
    const stream=identity.absolutePath ? fs.createReadStream(identity.absolutePath)
      : (await createReadStream(filePath,undefined,{workspace:identity.workspace})).stream;
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{headers});
  } catch { return unavailableHtmlPreview(); }
}
