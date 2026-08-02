import {
  handleDirectMcpOptions,
  handleDirectMcpPost,
  handleDirectMcpUnsupportedMethod,
} from '@/app/lib/mcp/server/streamable-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return handleDirectMcpPost(request);
}

export function GET(): Response {
  return handleDirectMcpUnsupportedMethod();
}

export function DELETE(): Response {
  return handleDirectMcpUnsupportedMethod();
}

export function OPTIONS(): Response {
  return handleDirectMcpOptions();
}
