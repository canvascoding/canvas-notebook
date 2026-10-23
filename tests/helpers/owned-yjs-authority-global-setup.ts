import { requireOwnedYjsQaTarget } from '../../scripts/lib/owned-yjs-authority-qa';

/** Runs before Playwright creates a browser or contacts any application route. */
export default async function ownedYjsAuthorityGlobalSetup(): Promise<void> {
  await requireOwnedYjsQaTarget();
}
