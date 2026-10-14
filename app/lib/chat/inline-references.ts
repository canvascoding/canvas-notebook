import { projectChatBodyText, type ChatBodyV1 } from './chat-body-contracts';
import { findActiveComposerReference, type ComposerReferenceMatch } from './composer-references';
import type { ChatInlineTextRange } from './inline-editor';

/** Search only editable text. A displayed caption never becomes a new reference. */
export function findInlineComposerReference(body: ChatBodyV1, range: ChatInlineTextRange): ComposerReferenceMatch | null {
  if (range.from !== range.to) return null;
  const text = projectChatBodyText(body), cursor = range.to;
  let match = findActiveComposerReference(text, cursor);
  const slash = text.lastIndexOf('/', cursor - 1), query = text.slice(slash + 1, cursor);
  if (slash >= 0 && cursor > slash && (!text[slash - 1] || /\s|[([{"'`,;]/u.test(text[slash - 1]))
    && !/[\r\n\t/@+]/u.test(query) && !query.includes('  ') && query.length <= 256) {
    const candidate: ComposerReferenceMatch = { kind: 'capability', trigger: '/', query, startIndex: slash, endIndex: cursor };
    if (!match || candidate.startIndex >= match.startIndex) match = candidate;
  }
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
