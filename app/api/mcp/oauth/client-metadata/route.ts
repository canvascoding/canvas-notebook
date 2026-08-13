import { NextRequest, NextResponse } from 'next/server';

import { getMcpOAuthClientMetadata } from '@/app/lib/mcp/oauth';

export async function GET(request: NextRequest) {
  try {
    const metadata = getMcpOAuthClientMetadata(request.nextUrl.origin);
    if (!metadata.client_id.startsWith('https://')) {
      return NextResponse.json(
        { error: 'MCP OAuth Client ID Metadata Documents require an HTTPS public base URL.' },
        { status: 400 },
      );
    }
    return NextResponse.json(metadata, {
      headers: {
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'MCP OAuth client metadata is unavailable.' },
      { status: 500 },
    );
  }
}
