import 'server-only';
import { htmlPreviewTicketPath, HTML_PREVIEW_ROUTE_PREFIX } from '../html-preview-ticket';
import { deliverHtmlPreviewTicket, unavailableHtmlPreview } from '../html-preview-delivery';
import type { PdfPreviewAccess } from './network-proxy';

/** Virtual HTTP origin served only by the job's proxy; it has no network host. */
export function pdfDocumentAccess(ticket: string, rootHtmlPath: string): PdfPreviewAccess {
  const pathPrefix=`${HTML_PREVIEW_ROUTE_PREFIX}/${encodeURIComponent(ticket)}`;
  return {
    url:'http://canvas-document.invalid'+htmlPreviewTicketPath(ticket,rootHtmlPath),
    pathPrefix,
    async load(url) {
      try {
        const filePath=url.pathname.slice(pathPrefix.length+1).split('/').map(decodeURIComponent).join('/');
        return deliverHtmlPreviewTicket(ticket,filePath);
      } catch { return unavailableHtmlPreview(); }
    },
  };
}
