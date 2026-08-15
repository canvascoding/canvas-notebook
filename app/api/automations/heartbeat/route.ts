import { NextResponse } from 'next/server';

const RETIRED_RESPONSE = {
  success: false,
  error: 'Heartbeat settings were replaced by workspace automations.',
  code: 'HEARTBEAT_RETIRED',
};

export async function GET() {
  return NextResponse.json(RETIRED_RESPONSE, { status: 410 });
}

export async function PUT() {
  return NextResponse.json(RETIRED_RESPONSE, { status: 410 });
}
