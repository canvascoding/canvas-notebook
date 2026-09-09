import Document from '@tiptap/extension-document';

export const CanvasDocument = Document.extend({
  renderMarkdown(node, helpers) {
    const children = node.content ?? [];
    return children.map((child, index) => {
      // Lists and custom block tokenizers can absorb otherwise blank lines.
      // Give every interior empty paragraph a portable marker, preserving its
      // identity when a move places authored content after a cursor paragraph.
      // The final cursor paragraph remains implicit, as in the default codec.
      if (child.type === 'paragraph' && !child.content?.length
        && index < children.length - 1) {
        return '&nbsp;';
      }
      return helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]);
    }).join('\n\n');
  },
});
