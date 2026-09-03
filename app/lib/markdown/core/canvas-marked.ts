import { Markdown, type MarkdownExtensionOptions } from '@tiptap/markdown';
import { Marked } from 'canvas-markdown-parser';
import { proseEntities } from './prose-entities';

export const CANVAS_MARKED_OPTIONS = {
  breaks: false,
  gfm: true,
} as const;

export const CANVAS_MARKDOWN_INDENTATION = {
  size: 2,
  style: 'space',
} as const;

const BARE_EMAIL_PATTERN = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const BARE_EMAIL_START_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
type TiptapMarkedInstance = NonNullable<MarkdownExtensionOptions['marked']>;

/**
 * Creates an isolated parser so editor instances and server-side codecs cannot
 * leak Marked tokenizer configuration into one another.
 *
 * Canvas keeps typed email addresses as plain text unless the author creates
 * an explicit Markdown link. Marked's GFM URL tokenizer otherwise promotes a
 * bare address to a mailto link during the next parse, making the Markdown
 * representation unstable across save/reload.
 */
export function createCanvasMarkedInstance(): TiptapMarkedInstance {
  const instance = new Marked(CANVAS_MARKED_OPTIONS);
  instance.use({
    extensions: [{
      name: 'canvasProseEntity',
      level: 'inline',
      start(source) { return source.search(/&#(?:x[0-9a-f]+|\d+);/iu); },
      tokenizer(source) {
        const raw = source.match(/^&#(?:x[0-9a-f]+|\d+);/iu)?.[0];
        if (!raw) return undefined;
        const text = proseEntities(raw);
        if (text === raw) return undefined;
        // Escape tokens are already decoded and must not be decoded a second time.
        return { type: 'escape', raw, text };
      },
    }, {
      name: 'canvasBareEmailText',
      level: 'inline',
      start(source) {
        return source.match(BARE_EMAIL_START_PATTERN)?.index;
      },
      tokenizer(source) {
        const match = source.match(BARE_EMAIL_PATTERN);
        if (!match) return undefined;
        return {
          type: 'text',
          raw: match[0],
          text: match[0],
        };
      },
    }],
  });
  // The app and @tiptap/markdown currently resolve separate compatible Marked
  // versions, so their nominal class types differ despite sharing this API.
  return instance as unknown as TiptapMarkedInstance;
}

export function createCanvasMarkdownExtension() {
  return Markdown.configure({
    indentation: CANVAS_MARKDOWN_INDENTATION,
    marked: createCanvasMarkedInstance(),
    markedOptions: CANVAS_MARKED_OPTIONS,
  });
}
