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

export function GET(request: Request): Response {
  return handleDirectMcpUnsupportedMethod(request);
}

export function DELETE(request: Request): Response {
  return handleDirectMcpUnsupportedMethod(request);
}

export function OPTIONS(request: Request): Response {
  return handleDirectMcpOptions(request);
}
