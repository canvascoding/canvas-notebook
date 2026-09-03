import Image from '@tiptap/extension-image';
import { imageAlignment, imageAlignmentFromStyle, imageDimension, IMAGE_ALIGNMENT_STYLES, parsePortableImage, serializePortableImage } from './portable-image';

export const CanvasImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null, parseHTML: (element) => imageDimension(element.getAttribute('width')) },
      height: { default: null, parseHTML: (element) => imageDimension(element.getAttribute('height')) },
      align: {
        default: null,
        parseHTML: (element) => imageAlignmentFromStyle(element.getAttribute('style')),
        renderHTML: (attrs) => imageAlignment(attrs.align) ? { style: IMAGE_ALIGNMENT_STYLES[imageAlignment(attrs.align)!] } : {},
      },
    };
  },
  markdownTokenizer: {
    name: 'canvasPortableImage', level: 'block',
    start: (source) => source.search(/^<img /mu),
    tokenize(source) {
      const raw = source.match(/^<img [^\r\n]+>[ \t]*(?:\r?\n|$)/u)?.[0];
      const image = raw ? parsePortableImage(raw) : null;
      return image ? { type: 'image', raw: raw!, image } : undefined;
    },
  },
  parseMarkdown(token, helpers) {
    if (token.image) return helpers.createNode('image', token.image);
    return Image.config.parseMarkdown?.call(this, token, helpers) ?? [];
  },
  renderMarkdown(node, helpers, context) {
    const attrs = node.attrs ?? {};
    if (attrs.width == null && attrs.height == null && attrs.align == null) {
      return Image.config.renderMarkdown?.call(this, node, helpers, context) ?? '';
    }
    const width = imageDimension(attrs.width);
    const height = imageDimension(attrs.height);
    const align = imageAlignment(attrs.align);
    if ((attrs.width != null && width === null) || (attrs.height != null && height === null)
      || (attrs.align != null && align === null)) throw new Error('Unsupported image dimensions or alignment');
    return serializePortableImage({ src: String(attrs.src ?? ''), alt: String(attrs.alt ?? ''),
      title: attrs.title == null ? null : String(attrs.title), width, height, align });
  },
});
