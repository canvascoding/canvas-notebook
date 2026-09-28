import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { readDictationAvailability } from '@/app/lib/dictation/service';
import { readDictationSettings, writeDictationSettings } from '@/app/lib/dictation/settings';

export async function GET(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const settings = await readDictationSettings();
  return NextResponse.json({
    success: true,
    data: { settings, status: await readDictationAvailability(settings) },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PATCH(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  try {
    const settings = await writeDictationSettings(await request.json());
    return NextResponse.json({
      success: true,
      data: { settings, status: await readDictationAvailability(settings) },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Invalid dictation settings.' }, { status: 400 });
  }
}
