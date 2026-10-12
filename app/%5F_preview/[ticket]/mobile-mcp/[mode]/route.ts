import { deliverMobileMcpAppTicket } from '@/app/lib/mcp/mobile-app-tickets';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ ticket: string; mode: string }> }) {
  const { ticket, mode } = await context.params;
  return deliverMobileMcpAppTicket(request, ticket, mode);
}
