import {
  directMcpProtectedResourceMetadataOptionsResponse,
  directMcpProtectedResourceMetadataResponse,
} from '@/app/lib/mcp/server/protected-resource-metadata';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return directMcpProtectedResourceMetadataResponse(request);
}

export async function OPTIONS(): Promise<Response> {
  return directMcpProtectedResourceMetadataOptionsResponse();
}
