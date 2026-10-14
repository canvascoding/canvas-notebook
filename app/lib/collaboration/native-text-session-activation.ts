import 'server-only';

// Root enables this single integration point after session, migration and
// actual ticket/socket ownership are accepted together. No production switch.
const enabled = false;
export function authenticatedNativeTextSessionEnabled(): boolean {
  return enabled || process.env.NODE_ENV === 'test' && process.env.CANVAS_TEST_NATIVE_TEXT_SESSION === '1';
}
