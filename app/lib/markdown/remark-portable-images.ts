import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';
import { IMAGE_ALIGNMENT_STYLES, parsePortableImage } from './core/portable-image';

export function remarkPortableImages() {
  return (tree: Root) => {
    visit(tree, 'html', (node, index, parent) => {
      const image = parsePortableImage(node.value);
      if (!image || index === undefined || !parent) return;
      parent.children[index] = {
        type: 'image', url: image.src, alt: image.alt, title: image.title,
        data: { hProperties: {
          ...(image.width !== null ? { width: image.width } : {}),
          ...(image.height !== null ? { height: image.height } : {}),
          ...(image.align ? { style: IMAGE_ALIGNMENT_STYLES[image.align] } : {}),
        } },
      };
    });
  };
}
