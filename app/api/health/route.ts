import { NextResponse } from 'next/server';
import { db } from '@/app/lib/db';

export async function GET() {
  const checks: Record<string, 'ok' | 'error'> = {
    app: 'ok',
  };

  let status = 200;

  try {
    db.$client.prepare('SELECT 1').get();
    checks.db = 'ok';
  } catch {
    checks.db = 'error';
    status = 503;
  }

  return NextResponse.json(
    {
      status: status === 200 ? 'healthy' : 'unhealthy',
      checks,
      timestamp: new Date().toISOString(),
    },
    { status }
  );
}
