import {
  getAuthorizationServerMetadata,
  headAuthorizationServerMetadata,
} from '@/app/lib/mcp/server/authorization-server-metadata';

export const dynamic = 'force-dynamic';

export const GET = getAuthorizationServerMetadata;
export const HEAD = headAuthorizationServerMetadata;
