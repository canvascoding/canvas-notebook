import { readFileSync, watchFile, unwatchFile } from 'node:fs';

import { serverPreferencesPath } from './terminal-policy';

export type DocumentReviewAvailability = {
  documentReviewEnabled: boolean;
  updatedAt: string | null;
};

// The instance policy is shared by HTTP, native tools, and MCP. A missing or
// malformed preference file cannot turn an experimental feature on.
export function readDocumentReviewAvailability(): DocumentReviewAvailability {
  try {
    const { settings } = JSON.parse(readFileSync(serverPreferencesPath(), 'utf8'));
    return {
      documentReviewEnabled: settings?.documentReviewEnabled === true,
      updatedAt: typeof settings?.documentReviewUpdatedAt === 'string'
        ? settings.documentReviewUpdatedAt
        : null,
    };
  } catch {
    return { documentReviewEnabled: false, updatedAt: null };
  }
}

export function subscribeDocumentReviewAvailability(
  listener: (state: DocumentReviewAvailability) => void,
): () => void {
  const filePath = serverPreferencesPath();
  let previous = readDocumentReviewAvailability();
  const onChange = () => {
    const next = readDocumentReviewAvailability();
    if (next.documentReviewEnabled === previous.documentReviewEnabled
      && next.updatedAt === previous.updatedAt) return;
    previous = next;
    listener(next);
  };
  // watchFile handles an initially missing file and atomic rename writes.
  watchFile(filePath, { interval: 250, persistent: false }, onChange);
  return () => unwatchFile(filePath, onChange);
}
