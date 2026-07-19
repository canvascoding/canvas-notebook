import type { BrowserViewErrorCode, BrowserViewFailure } from './types';

type BrowserViewErrorContext =
  | 'capture'
  | 'connection'
  | 'navigate'
  | 'operation'
  | 'subscribe';

function failure(
  code: BrowserViewErrorCode,
  error: string,
  retryable: boolean,
  fatal: boolean,
): BrowserViewFailure {
  return { code, error, retryable, fatal };
}

export function browserViewFailure(
  error: unknown,
  context: BrowserViewErrorContext = 'operation',
): BrowserViewFailure {
  const message = error instanceof Error ? error.message : '';
  const normalized = message.toLowerCase();

  if (normalized.includes('ticket') && normalized.includes('expired')) {
    return failure('TICKET_EXPIRED', 'The browser view ticket expired.', true, true);
  }
  if (normalized.includes('ticket is already connected') || normalized.includes('already subscribed')) {
    return failure('VIEW_CONFLICT', 'This browser view is already open in another connection.', true, true);
  }
  if (normalized.includes('workspace scope changed') || normalized.includes('does not match the authenticated session')) {
    return failure('SESSION_SCOPE_CHANGED', 'The browser session scope changed. Open a new view.', true, true);
  }
  if ((context === 'connection' || context === 'subscribe') && normalized.includes('not found')) {
    return failure('SESSION_SCOPE_CHANGED', 'The browser session is no longer available.', false, true);
  }
  if (normalized.includes('capacity is currently exhausted')) {
    return failure('CAPACITY_EXHAUSTED', 'All interactive browser view slots are currently in use.', true, true);
  }
  if (
    normalized.includes('browser runtime is not available')
    || normalized.includes('browser tool is not available')
    || normalized.includes('interactive browser view is unavailable')
    || normalized.includes('effective memory')
  ) {
    return failure('RESOURCE_UNAVAILABLE', 'The interactive browser is unavailable on this system.', true, true);
  }
  if (normalized.includes('rate limit')) {
    return failure('RATE_LIMITED', 'Too many browser commands were sent. Wait briefly and try again.', true, false);
  }
  if (normalized.includes('file chooser')) {
    return failure('FILE_CHOOSER_REQUIRED', 'Choose a file field in the webpage before selecting a workspace file.', false, false);
  }
  if (
    normalized.includes('workspace permission')
    || normalized.includes('workspace path')
    || normalized.includes('outside workspace')
    || normalized.includes('workspace file selection')
  ) {
    return failure('FILE_ACCESS_DENIED', 'The selected file is not available in this browser session workspace.', false, false);
  }
  if (normalized.includes('upload file is too large') || normalized.includes('uploads require regular')) {
    return failure('FILE_UPLOAD_FAILED', 'The selected workspace file cannot be uploaded.', false, false);
  }
  if (normalized.includes('download file is too large')) {
    return failure('DOWNLOAD_TOO_LARGE', 'The browser download exceeds the allowed size.', false, false);
  }
  if (normalized.includes('browser download')) {
    return failure('DOWNLOAD_FAILED', 'The browser download could not be saved to the workspace.', true, false);
  }
  if (normalized.includes('another browser view') || normalized.includes('browser control')) {
    return failure('CONTROL_CONFLICT', 'Browser control is currently held by another participant.', false, false);
  }
  if (
    normalized.includes('target closed')
    || normalized.includes('session closed')
    || normalized.includes('page crashed')
    || normalized.includes('browser has disconnected')
  ) {
    return failure('PAGE_CRASHED', 'The managed browser page stopped unexpectedly.', true, true);
  }
  if (context === 'navigate') {
    const blocked = normalized.includes('blocked')
      || normalized.includes('only http')
      || normalized.includes('url must be absolute')
      || normalized.includes('could not verify target host');
    return blocked
      ? failure('NAVIGATION_BLOCKED', 'The address is not allowed by the browser security policy.', false, false)
      : failure('NAVIGATION_FAILED', 'The page could not be opened.', true, false);
  }
  if (context === 'capture') {
    return failure('CAPTURE_FAILED', 'The browser frame could not be captured.', true, false);
  }
  if (context === 'connection' || context === 'subscribe') {
    return failure('CONNECTION_FAILED', 'The browser view could not be connected.', true, true);
  }
  return failure('OPERATION_FAILED', 'The browser command could not be completed.', true, false);
}
