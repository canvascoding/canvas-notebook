import {
  directMcpProtectedResourceMetadataOptionsResponse,
  directMcpProtectedResourceMetadataResponse,
} from '@/app/lib/mcp/server/protected-resource-metadata';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return directMcpProtectedResourceMetadataResponse();
}

export async function OPTIONS(): Promise<Response> {
  return directMcpProtectedResourceMetadataOptionsResponse();
}
