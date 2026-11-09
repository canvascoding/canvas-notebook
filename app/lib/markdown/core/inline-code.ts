import { Code } from '@tiptap/extension-code';

// Keep the code mark innermost so Markdown can serialize bold around its span.
export const CanvasInlineCode = Code.extend({
  excludes: 'code italic strike underline link canvasHighlight',
});
