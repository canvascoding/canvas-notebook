export const roomReadConsoleMessage = 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)';

/** Qualify only bounded, structured busy metadata reads that actually recovered.
 * Unknown errors, changed identity and successes before the failure cannot qualify.
 */
export function recoveredRoomReadUrls(responses, consoleErrors) {
  const recovered = new Set();
  for (const url of new Set(consoleErrors.map(error => error.url))) {
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.pathname !== '/api/files/read' || parsed.searchParams.get('meta') !== '1') continue;
    const reads = responses.filter(response => response.url === url);
    const failures = reads.filter(response => response.status >= 400);
    const messages = consoleErrors.filter(error => error.url === url);
    if (!failures.length || failures.length > 2 || failures.length !== messages.length
      || messages.some(error => error.message !== roomReadConsoleMessage)
      || failures.some(response => response.status !== 503 || response.code !== 'ROOM_OWNER_BUSY')) continue;
    const successes = reads.filter(response => response.status === 200 && typeof response.documentId === 'string' && response.documentId.length > 0);
    if (new Set(successes.map(response => response.documentId)).size !== 1
      || reads.some((failure, index) => failure.status >= 400 && !reads.some((success, next) => next > index
        && success.status === 200 && typeof success.documentId === 'string' && success.documentId.length > 0
        && Number.isFinite(success.at) && Number.isFinite(failure.at) && success.at >= failure.at && success.at - failure.at <= 5_000))) continue;
    recovered.add(url);
  }
  return recovered;
}
