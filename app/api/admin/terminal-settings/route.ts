import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { setTerminalEnabled } from '@/app/lib/server-settings';
import { getTerminalClient } from '@/app/lib/terminal-client';
import { readTerminalAvailability } from '@/app/lib/terminal-policy';

// Serialize changes through persistence and runtime revocation, so concurrent
// admin requests cannot overtake a pending disable operation.
let pendingUpdate: Promise<unknown> = Promise.resolve();

export async function PATCH(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.terminalEnabled !== 'boolean') {
    return NextResponse.json({ error: 'terminalEnabled must be a boolean.' }, { status: 400 });
  }
  try {
    const update = pendingUpdate.then(async () => {
      await setTerminalEnabled(admin.session.user.id, body.terminalEnabled);
      // The service reads the policy itself; the protocol cannot grant access.
      await getTerminalClient().refreshPolicy();
      return readTerminalAvailability();
    });
    pendingUpdate = update.catch(() => undefined);
    const data = await update;
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Terminal settings] Update failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to apply terminal settings.', data: readTerminalAvailability() }, { status: 503 });
  }
}
