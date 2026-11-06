import { verifyRegularCollaborationTarget, regularCollaborationPrerequisite } from '../../scripts/lib/regular-collaboration-target.mjs';

export default async function regularCollaborationSetup() {
  try {
    await verifyRegularCollaborationTarget();
  } catch (error) {
    // Preserve only the deliberately sanitized prerequisite messages.
    if (error instanceof Error && error.message.startsWith(regularCollaborationPrerequisite)) throw error;
    throw new Error(`${regularCollaborationPrerequisite}: Verify a healthy local PostgreSQL Team target, its DATA, two managed writers, primary cleanup rights, and disabled Review Center.`);
  }
}
