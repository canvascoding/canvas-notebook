import { NextRequest, NextResponse } from 'next/server';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { readLocalPreparation, startLocalPreparation } from '@/app/lib/dictation/local-preparation';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { DICTATION_MODELS } from '@/app/lib/transcription/config';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  try { return NextResponse.json({ success: true, data: await readLocalPreparation() }, { headers }); }
  catch { return NextResponse.json({ success: false, error: 'Could not read model preparation status.' }, { status: 503, headers }); }
}

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, { limit: 6, windowMs: 60_000, keyPrefix: 'dictation-local-test' });
  if (!limited.ok) return limited.response;
  const body = await request.json().catch(() => null) as { model?: unknown } | null;
  if (typeof body?.model !== 'string' || !DICTATION_MODELS.local.includes(body.model)) return NextResponse.json({ success: false, error: 'Choose a supported local model.' }, { status: 400, headers });
  try { return NextResponse.json({ success: true, data: await startLocalPreparation(body.model) }, { status: 202, headers }); }
  catch (error) { return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Could not prepare the model.' }, { status: 409, headers }); }
}
