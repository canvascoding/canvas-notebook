import { NextResponse } from 'next/server';
import { getGatewayToolkits } from '@/app/lib/composio/composio-gateway';

export async function GET() {
  try {
    return NextResponse.json(await getGatewayToolkits());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ toolkits: [], error: message }, { status: 500 });
  }
}
