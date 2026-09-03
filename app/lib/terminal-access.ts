import 'server-only';

import { NextResponse } from 'next/server';
import { readTerminalAvailability, TERMINAL_DISABLED_CODE } from './terminal-policy';

export function terminalAccessDenied(): NextResponse | null {
  if (readTerminalAvailability().terminalEnabled) return null;
  return NextResponse.json(
    { error: 'Terminal is disabled by an administrator.', code: TERMINAL_DISABLED_CODE },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  );
}
