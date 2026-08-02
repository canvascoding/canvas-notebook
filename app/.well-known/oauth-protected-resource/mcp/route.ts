import {
  directMcpProtectedResourceMetadataOptionsResponse,
  directMcpProtectedResourceMetadataResponse,
} from '@/app/lib/mcp/server/protected-resource-metadata';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return directMcpProtectedResourceMetadataResponse();
}

export function OPTIONS(): Response {
  return directMcpProtectedResourceMetadataOptionsResponse();
}
