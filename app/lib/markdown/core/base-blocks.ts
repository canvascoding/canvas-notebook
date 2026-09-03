import Paragraph from '@tiptap/extension-paragraph';
import Blockquote from '@tiptap/extension-blockquote';
import Heading from '@tiptap/extension-heading';

const EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;';

// A newly inserted quote serializes as `>`. Marked gives it no child tokens,
// but the blockquote schema requires at least one block, including on reload.
export const CanvasBlockquote = Blockquote.extend({
  parseMarkdown(token, helpers) {
    const parseBlocks = helpers.parseBlockChildren ?? helpers.parseChildren;
    const children = parseBlocks(token.tokens ?? []);
    return helpers.createNode('blockquote', undefined,
      children.length ? children : [helpers.createNode('paragraph')]);
  },
});
const THEMATIC_BREAK_PARAGRAPH_PATTERN = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u;

// Rich Markdown tokenizers need to run before generic block tokenizers, which
// gives their nodes a high schema priority. Keep paragraph above those block
// nodes so ProseMirror fills empty containers (especially table cells) with an
// editable paragraph instead of an empty callout.
export const CanvasParagraph = Paragraph.extend({
  priority: 1200,

  renderMarkdown(node, helpers, context) {
    if (!node) return '';

    const content = Array.isArray(node.content) ? node.content : [];
    if (content.length === 0) {
      const previousContent = Array.isArray(context?.previousNode?.content)
        ? context.previousNode.content
        : [];
      const previousNodeIsEmptyParagraph = context?.previousNode?.type === 'paragraph'
        && previousContent.length === 0;
      return previousNodeIsEmptyParagraph ? EMPTY_PARAGRAPH_MARKDOWN : '';
    }

    const rendered = helpers.renderChildren(content);
    return THEMATIC_BREAK_PARAGRAPH_PATTERN.test(rendered)
      ? `\\${rendered}`
      : rendered;
  },
});


// Empty Yjs nodes omit content; preserve the authored heading marker.
export const CanvasHeading = Heading.extend({
  renderMarkdown(node, helpers) {
    return '#'.repeat(Number(node.attrs?.level) || 1) + ' ' + helpers.renderChildren(node.content ?? []);
  },
});
