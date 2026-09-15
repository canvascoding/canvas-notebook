import { deliverHtmlPreviewTicket, unavailableHtmlPreview } from '@/app/lib/html-preview-delivery';

export const dynamic='force-dynamic';
export const runtime='nodejs';

async function deliver(context:{params:Promise<{ticket:string;path:string[]}>}) {
  try {
    const {ticket,path}=await context.params;
    return deliverHtmlPreviewTicket(ticket,path.join('/'),{sameOrigin:true});
  } catch {
    return unavailableHtmlPreview();
  }
}

export async function GET(_request: Request, context:{params:Promise<{ticket:string;path:string[]}>}) {
  return deliver(context);
}

export async function HEAD(_request: Request, context:{params:Promise<{ticket:string;path:string[]}>}) {
  return deliver(context);
}
