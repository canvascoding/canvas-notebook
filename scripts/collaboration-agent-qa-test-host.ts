/** Explicit production QA entry; never imported by the application. */
import { startOwnedCollaborationAgentTestHost } from './collaboration-agent-test-host';

export async function main(): Promise<void> {
  await startOwnedCollaborationAgentTestHost();
}

if (require.main === module) {
  void main().catch(() => {
    console.error('Owned QA agent tool host refused startup.');
    // No client can use this host before its private receipt is published.
    // Exit also closes any HTTP/socket listener opened before startup failed.
    process.exit(1);
  });
}
