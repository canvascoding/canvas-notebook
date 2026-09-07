import Document from '@tiptap/extension-document';

export const CanvasDocument = Document.extend({
  renderMarkdown(node, helpers) {
    const children = node.content ?? [];
    return children.map((child, index) => {
      // Blank lines after a list can be absorbed into that list by GFM. Give
      // the authored empty paragraph a portable marker, preserving the split.
      // The final cursor paragraph remains implicit, as in the default codec.
      if (child.type === 'paragraph' && !child.content?.length
        && index < children.length - 1
        && ['orderedList', 'bulletList', 'taskList'].includes(children[index - 1]?.type ?? '')) {
        return '&nbsp;';
      }
      return helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]);
    }).join('\n\n');
  },
});
