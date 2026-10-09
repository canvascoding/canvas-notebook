import { Tokenizer } from 'parse5';

import { getCanvasNotebookMarkdownLinkTarget } from './obsidian-link-resolver';

const SINGLE_URL_ATTRIBUTE = /(?:^|[^a-z0-9_])(?:href|src|poster|action|formaction|cite|background|longdesc|usemap|profile|manifest|data|codebase)$/u;
const UNSUPPORTED_URL_ATTRIBUTE = /(?:^|[^a-z0-9_])(?:srcset|imagesrcset|ping|archive|srcdoc)$/u;

/** Classifies original attributes without dropping tags through HTML tree repair. */
export function hasUnevaluatedWorkspaceHtmlLinks(html: string): boolean {
  let unevaluated = false;
  const ignore = () => {};
  const tokenizer = new Tokenizer({}, {
    onStartTag: (token) => {
      for (const attribute of token.attrs) {
        const { name } = attribute;
        const value = attribute.value.trim();
        if (UNSUPPORTED_URL_ATTRIBUTE.test(name)
          || /^on[a-z]/u.test(name)
          || name === 'style' && (/url\s*\(|@import/iu.test(value) || value.includes('\\'))) {
          unevaluated = true;
          continue;
        }
        if (!SINGLE_URL_ATTRIBUTE.test(name)) continue;
        if (!value || getCanvasNotebookMarkdownLinkTarget(value)) {
          unevaluated = true;
          continue;
        }
        if (value.startsWith('#')) continue;
        if (!/^(?:https?:|mailto:|data:|\/\/)/iu.test(value)) unevaluated = true;
      }
    },
    onParseError: () => { unevaluated = true; },
    onEndTag: ignore,
    onComment: ignore,
    onDoctype: ignore,
    onEof: ignore,
    onCharacter: ignore,
    onNullCharacter: ignore,
    onWhitespaceCharacter: ignore,
  });
  tokenizer.write(html, true);
  return unevaluated;
}
