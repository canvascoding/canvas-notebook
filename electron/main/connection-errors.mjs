const ERROR_REASONS = {
  SERVER_NOT_FOUND: 'server-not-found',
  OFFLINE: 'offline',
  SERVER_UNAVAILABLE: 'server-unavailable',
  CONNECTION_TIMED_OUT: 'connection-timed-out',
  CERTIFICATE_ERROR: 'certificate-error',
  CONNECTION_FAILED: 'connection-failed',
};

/**
 * Converts Chromium and network error details into a stable, renderer-safe
 * reason. Raw load errors can contain internal file paths, so they must never
 * be shown on the connection screen.
 */
export function classifyServerLoadFailure(error) {
  const detail = getErrorDetail(error);

  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(detail)) return ERROR_REASONS.SERVER_NOT_FOUND;
  if (/ERR_INTERNET_DISCONNECTED|ENETUNREACH|ENETDOWN/i.test(detail)) return ERROR_REASONS.OFFLINE;
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(detail)) return ERROR_REASONS.SERVER_UNAVAILABLE;
  if (/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ETIMEDOUT/i.test(detail)) return ERROR_REASONS.CONNECTION_TIMED_OUT;
  if (/ERR_CERT_|CERTIFICATE|SSL/i.test(detail)) return ERROR_REASONS.CERTIFICATE_ERROR;

  return ERROR_REASONS.CONNECTION_FAILED;
}

function getErrorDetail(error) {
  const details = [];
  const seen = new Set();
  let current = error;

  // Node's fetch wraps DNS and socket errors in Error#cause. Walk the short
  // chain so manually entered URLs receive the same useful guidance as a
  // saved server that fails to load in Chromium.
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    details.push(current.code, current.message);
    current = current.cause;
  }

  return details.length ? details.filter(Boolean).join(' ') : String(error ?? '');
}

export { ERROR_REASONS };
