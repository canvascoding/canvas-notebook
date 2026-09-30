import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { readDictationCredentialStatuses } from '@/app/lib/dictation/credentials';
import { readLocalDictationRuntimeStatus, startLocalDictationRuntimeInstall, type LocalDictationRuntimeStatus } from '@/app/lib/dictation/runtime-install';
import { readDictationAvailability } from '@/app/lib/dictation/service';
import { readDictationSettings, writeDictationSettings } from '@/app/lib/dictation/settings';

function publicInstallStatus(status: LocalDictationRuntimeStatus) {
  return { state: status.state, message: status.message };
}

export async function GET(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const settings = await readDictationSettings();
  return NextResponse.json({
    success: true,
    data: {
      settings,
      status: await readDictationAvailability(settings),
      credentials: await readDictationCredentialStatuses(),
      localInstall: publicInstallStatus(await readLocalDictationRuntimeStatus()),
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PATCH(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  try {
    const settings = await writeDictationSettings(await request.json());
    return NextResponse.json({
      success: true,
      data: {
        settings,
        status: await readDictationAvailability(settings),
        credentials: await readDictationCredentialStatuses(),
        localInstall: publicInstallStatus(await readLocalDictationRuntimeStatus()),
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Invalid dictation settings.' }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  try {
    const localInstall = await startLocalDictationRuntimeInstall();
    return NextResponse.json({ success: true, data: { localInstall: publicInstallStatus(localInstall) } }, {
      status: localInstall.state === 'installing' ? 202 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Could not start local dictation installation.',
    }, { status: 503 });
  }
}
