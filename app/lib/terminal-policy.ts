import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';

import { resolveSystemSettingsDir } from './runtime-data-paths';

export type TerminalAvailability = {
  terminalEnabled: boolean;
  terminalRevocationId?: string | null;
  terminalUpdatedAt: string | null;
};

export const TERMINAL_DISABLED_CODE = 'terminal_disabled';

export function serverPreferencesPath(): string {
  return path.join(resolveSystemSettingsDir(), 'server-preferences.json');
}

// Shared by the HTTP server and the separate terminal process. Only an explicit
// boolean true grants access; missing, unreadable or malformed settings deny it.
export function readTerminalAvailability(): TerminalAvailability {
  try {
    const { settings } = JSON.parse(readFileSync(serverPreferencesPath(), 'utf8'));
    return {
      terminalEnabled: settings?.terminalEnabled === true,
      terminalRevocationId: typeof settings?.terminalRevocationId === 'string' ? settings.terminalRevocationId : null,
      terminalUpdatedAt: typeof settings?.terminalUpdatedAt === 'string' ? settings.terminalUpdatedAt : null,
    };
  } catch {
    return { terminalEnabled: false, terminalUpdatedAt: null };
  }
}

export function subscribeTerminalAvailability(listener: (state: TerminalAvailability) => void): () => void {
  const filePath = serverPreferencesPath();
  let previous = readTerminalAvailability();
  const onChange = () => {
    const next = readTerminalAvailability();
    if (next.terminalEnabled === previous.terminalEnabled && next.terminalUpdatedAt === previous.terminalUpdatedAt && next.terminalRevocationId === previous.terminalRevocationId) return;
    previous = next;
    listener(next);
  };
  // watchFile also handles an initially missing file and atomic rename writes.
  watchFile(filePath, { interval: 250, persistent: false }, onChange);
  return () => unwatchFile(filePath, onChange);
}
