import type { MarkdownRichModeReason } from './rich-markdown-codec';

export type MarkdownSourceModeNotice = 'markdown' | 'presentation';

export function getMarkdownSourceModeNotice(
  reason: MarkdownRichModeReason,
  isPresentationDocument: boolean,
): MarkdownSourceModeNotice {
  return reason === 'unsupported_marp_directive' && isPresentationDocument
    ? 'presentation'
    : 'markdown';
}
