import { projectChatBodyText, type ChatBodyV1 } from './chat-body-contracts';
import { findActiveComposerReference, type ComposerReferenceMatch } from './composer-references';
import type { ChatInlineTextRange } from './inline-editor';

/** Search only editable text. A displayed caption never becomes a new reference. */
export function findInlineComposerReference(body: ChatBodyV1, range: ChatInlineTextRange): ComposerReferenceMatch | null {
  if (range.from !== range.to) return null;
  const text = projectChatBodyText(body), cursor = range.to;
  const match = findActiveComposerReference(text, cursor);
  if (!match) return null;
  const bundles = new Map(body.bundles.map(bundle => [bundle.id, bundle]));
  let offset = 0;
  for (const part of body.parts) {
    const length = part.type === 'text' ? part.text.length : bundles.get(part.bundleId)!.caption.length;
    if (part.type === 'extension_reference' && match.startIndex < offset + length && match.endIndex > offset) return null;
    offset += length;
  }
  return match;
}
