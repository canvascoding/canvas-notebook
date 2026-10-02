export function emailOAuthFeedbackKey(code: unknown): 'errors.oauthCancelled' | 'errors.oauthIncomplete' | 'errors.oauthUnauthorized' | 'errors.oauthFailed' {
  if (code === 'cancelled' || code === 'access_denied' || code === 'user_cancelled') return 'errors.oauthCancelled';
  if (code === 'missing_code_or_state') return 'errors.oauthIncomplete';
  if (code === 'unauthorized') return 'errors.oauthUnauthorized';
  return 'errors.oauthFailed';
}
