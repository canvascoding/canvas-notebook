import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getBulkJob, cancelBulkJob } from '@/app/lib/integrations/studio-bulk-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: _request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const job = await getBulkJob(id);
    if (!job || job.userId !== session.user.id) {
      return NextResponse.json({ success: false, error: 'Bulk job not found' }, { status: 404 });
    }

    await cancelBulkJob(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      const status = error.code === 'INVALID_STATUS' ? 409 : 400;
      return NextResponse.json({ success: false, error: error.userMessage }, { status });
    }
    console.error('[Studio Bulk] Cancel error:', error);
    return NextResponse.json({ success: false, error: 'Failed to cancel bulk job' }, { status: 500 });
  }
}