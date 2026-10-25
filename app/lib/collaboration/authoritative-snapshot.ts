import 'server-only';

import { validateRichMarkdownYDoc } from './markdown-state';
import { CollaborationCheckpointValidationError } from './checkpoint-errors';
import type { PersistedCollaborationState } from './persistence';
import { Y } from './server-runtime';

export type AuthoritativeCollaborationSnapshot = {
  canonicalContent: string;
  checkpointSequence: number;
  documentSequence: number;
  stateVector: string;
};

/**
 * Serializes only the persisted Yjs snapshot. Callers cannot supply a second
 * text truth that happens to share the same sequence or state vector.
 */
export function authoritativeCollaborationSnapshot(
  state: PersistedCollaborationState,
): AuthoritativeCollaborationSnapshot {
  const doc = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(doc, state.yjsState);
    const encodedVector = Buffer.from(Y.encodeStateVector(doc));
    if (!encodedVector.equals(Buffer.from(state.stateVector))) {
      throw new Error('Persisted collaboration state and state vector do not match.');
    }

    let canonicalContent: string;
    if (state.representation === 'plain_text') {
      canonicalContent = doc.getText('content').toString();
    } else {
      const validation = validateRichMarkdownYDoc(doc);
      if (!validation.valid || validation.markdown === undefined) {
        throw new CollaborationCheckpointValidationError(validation.code || 'schema_invalid');
      }
      canonicalContent = validation.markdown;
    }
    return {
      canonicalContent: canonicalContent.replace(/\r\n?/gu, '\n'),
      checkpointSequence: state.checkpointSequence,
      documentSequence: state.documentSequence,
      stateVector: encodedVector.toString('base64'),
    };
  } finally {
    doc.destroy();
  }
}

