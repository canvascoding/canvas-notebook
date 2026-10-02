import { readFileSync, watchFile, unwatchFile } from 'node:fs';

import { serverPreferencesPath } from './terminal-policy';

export type StudioBulkAvailability = {
  studioBulkEnabled: boolean;
  updatedAt: string | null;
};

// The instance policy applies to web, mobile, and agent job creation. Existing
// installations and malformed preferences keep this experimental feature off.
export function readStudioBulkAvailability(): StudioBulkAvailability {
  try {
    const { settings } = JSON.parse(readFileSync(serverPreferencesPath(), 'utf8'));
    const updatedAt = typeof settings?.studioBulkUpdatedAt === 'string'
      && Number.isFinite(Date.parse(settings.studioBulkUpdatedAt)) ? settings.studioBulkUpdatedAt : null;
    return {
      studioBulkEnabled: settings?.studioBulkEnabled === true
        && (settings?.studioBulkUpdatedAt === undefined || updatedAt !== null),
      updatedAt,
    };
  } catch {
    return { studioBulkEnabled: false, updatedAt: null };
  }
}

export function subscribeStudioBulkAvailability(
  listener: (state: StudioBulkAvailability) => void,
): () => void {
  const filePath = serverPreferencesPath();
  let previous = readStudioBulkAvailability();
  const onChange = () => {
    const next = readStudioBulkAvailability();
    if (next.studioBulkEnabled === previous.studioBulkEnabled && next.updatedAt === previous.updatedAt) return;
    previous = next;
    listener(next);
  };
  watchFile(filePath, { interval: 250, persistent: false }, onChange);
  return () => unwatchFile(filePath, onChange);
}
