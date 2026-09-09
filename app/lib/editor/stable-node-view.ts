import type { NodeViewRenderer } from '@tiptap/core';

/** Keep queued React portal mounting out of ProseMirror's DOM input path. */
export function withStableNodeViewMount(renderer: NodeViewRenderer): NodeViewRenderer {
  return props => {
    const view = renderer(props);
    const ignoreMutation = view.ignoreMutation?.bind(view);
    view.ignoreMutation = mutation => {
      const { dom, contentDOM } = view;
      if (contentDOM && mutation.type === 'childList'
        && !contentDOM.contains(mutation.target) && dom.contains(mutation.target)) {
        const changed = [...mutation.addedNodes, ...mutation.removedNodes];
        // ReactNodeView first attaches contentDOM to its temporary host, then
        // moves that same element into NodeViewContent when the portal mounts.
        // Tiptap's mobile Enter workaround otherwise treats these editable
        // wrappers as input and repeatedly destroys/recreates the node view.
        const movedContent = changed.length > 0 && changed.every(node => node === contentDOM);
        const mountedShell = mutation.target === dom && mutation.removedNodes.length === 0
          && mutation.addedNodes.length === 1
          && mutation.addedNodes[0] instanceof HTMLElement
          && mutation.addedNodes[0].hasAttribute('data-node-view-wrapper')
          && mutation.addedNodes[0].contains(contentDOM);
        if (movedContent || mountedShell) return true;
      }
      return ignoreMutation?.(mutation) ?? false;
    };
    return view;
  };
}
