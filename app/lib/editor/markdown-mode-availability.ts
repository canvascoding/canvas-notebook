import type { CollaborationRepresentation } from '../collaboration/types';

/** Rich collaboration exposes a Markdown projection, not an editable source. */
export function isMarkdownSourceModeSupported(
  collaborationEnabled: boolean,
  representation?: CollaborationRepresentation,
): boolean {
  return !collaborationEnabled || representation === 'plain_text';
}
