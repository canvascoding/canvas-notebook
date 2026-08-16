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

export async function GET(request: Request): Promise<Response> {
  return handleDirectMcpUnsupportedMethod(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleDirectMcpUnsupportedMethod(request);
}

export async function OPTIONS(request: Request): Promise<Response> {
  return handleDirectMcpOptions(request);
}
