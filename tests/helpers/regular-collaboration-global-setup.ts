import { verifyRegularCollaborationTarget, regularCollaborationPrerequisite } from '../../scripts/lib/regular-collaboration-target.mjs';

export default async function regularCollaborationSetup() {
  try {
    await verifyRegularCollaborationTarget();
  } catch {
    // Detailed fixture facts/credentials must not leak through global setup errors.
    throw new Error(`${regularCollaborationPrerequisite}: Verify a healthy local PostgreSQL Team target, its DATA, two managed users with shared write/delete rights, and disabled Review Center.`);
  }
}
