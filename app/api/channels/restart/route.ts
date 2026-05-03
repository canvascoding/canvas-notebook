import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getChannelManager } from '@/app/lib/channels/manager';

const RESTART_TIMEOUT_MS = 20_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Restart timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const manager = getChannelManager();
    await withTimeout(manager.restart(), RESTART_TIMEOUT_MS);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] channels/restart error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to restart channels' },
      { status: 500 },
    );
  }
}
