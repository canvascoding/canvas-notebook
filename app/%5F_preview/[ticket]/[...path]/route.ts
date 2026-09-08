import { isHtmlPreviewHost } from '@/app/lib/html-preview-origin';
import { deliverHtmlPreviewTicket, unavailableHtmlPreview } from '@/app/lib/html-preview-delivery';

export const dynamic='force-dynamic';
export const runtime='nodejs';

export async function GET(request: Request, context:{params:Promise<{ticket:string;path:string[]}>}) {
  if(!isHtmlPreviewHost(request.headers.get('host'))) return unavailableHtmlPreview();
  const {ticket,path}=await context.params;
  return deliverHtmlPreviewTicket(ticket,path.join('/'));
}
