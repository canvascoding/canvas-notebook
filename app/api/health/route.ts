import { NextResponse } from 'next/server';
import { openDb } from '@/app/lib/db';

export async function GET() {
  const checks: Record<string, 'ok' | 'error'> = {
    app: 'ok',
  };

  let status = 200;
  let connection: Awaited<ReturnType<typeof openDb>> | null = null;

  try {
    connection = await openDb();
    connection.get('SELECT 1');
    checks.db = 'ok';
  } catch {
    checks.db = 'error';
    status = 503;
  } finally {
    connection?.close();
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
