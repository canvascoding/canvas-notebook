import { deliverMcpAppTicket } from '@/app/lib/mcp/apps-host';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ ticket: string; mode: string }> }) {
  const { ticket, mode } = await context.params;
  return deliverMcpAppTicket(request, ticket, mode);
}
