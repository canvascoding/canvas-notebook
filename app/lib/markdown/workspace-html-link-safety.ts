import { Tokenizer } from 'parse5';

import { getCanvasNotebookMarkdownLinkTarget } from './obsidian-link-resolver';
import { proseEntities } from './core/prose-entities';

const SINGLE_URL_ATTRIBUTE = /(?:^|[^a-z0-9_])(?:href|src|poster|action|formaction|cite|background|longdesc|usemap|profile|manifest|data|codebase|lowsrc|dynsrc)$/u;
const UNSUPPORTED_URL_ATTRIBUTE = /(?:^|[^a-z0-9_])(?:srcset|imagesrcset|ping|archive|srcdoc|attributionsrc)$/u;
const UNSUPPORTED_HTML_TAG = /^(?:base|script|style|iframe|object|embed|svg|math|template|meta|applet|param)$/u;
const STATIC_HTML_TAGS = new Set(('a img div span p br hr strong em b i u s del ins blockquote pre code kbd samp small sub sup mark q cite abbr time '
  + 'details summary ul ol li dl dt dd table thead tbody tfoot tr td th caption colgroup col h1 h2 h3 h4 h5 h6 figure figcaption '
  + 'section article aside header footer main nav address').split(' '));
const STATIC_GLOBAL_ATTRIBUTES = new Set('id class title lang dir hidden role tabindex translate inert draggable spellcheck contenteditable accesskey style'.split(' '));
const STATIC_TAG_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  img: new Set('alt width height loading decoding fetchpriority crossorigin referrerpolicy ismap'.split(' ')),
  a: new Set('target rel download hreflang type referrerpolicy name'.split(' ')),
  details: new Set(['open']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
  time: new Set(['datetime']),
  td: new Set(['colspan', 'rowspan', 'headers']),
  th: new Set(['colspan', 'rowspan', 'headers', 'scope', 'abbr']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
};

/** The notebook's portable-image reader decodes a smaller entity set than a browser. */
function rawAttributeValue(attribute: string): string | null {
  const match = attribute.match(/^[^\s=]+\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))\s*$/u);
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

/** Certify only simple layout values: arbitrary CSS can hide resource paths without url(). */
function isStaticHtmlLayoutStyle(style: string): boolean {
  const length = /^(?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|%|vh|vw|vmin|vmax))$/u;
  return style.split(';').every((part) => {
    const declaration = part.trim();
    if (!declaration) return true;
    const match = declaration.match(/^([a-z-]+)\s*:\s*(.*?)\s*$/iu);
    if (!match) return false;
    const property = match[1].toLowerCase();
    const value = match[2].toLowerCase().replace(/\s*!important$/u, '').trim();
    if (property === 'display') return /^(?:none|block|inline|inline-block|flex|inline-flex|grid|inline-grid|contents|table|table-row|table-cell)$/u.test(value);
    if (/^(?:(?:min|max)-)?(?:width|height)$/u.test(property)) return value === 'auto' || length.test(value);
    if (/^(?:margin|padding)(?:-(?:top|right|bottom|left))?$/u.test(property)) {
      const values = value.split(/\s+/u);
      const shorthand = property === 'margin' || property === 'padding';
      return values.length <= (shorthand ? 4 : 1)
        && values.every((item) => length.test(item) || property.startsWith('margin') && item === 'auto');
    }
    return false;
  });
}

/** HTML entities are already decoded by parse5. Decode the file path once, without Markdown escapes. */
function explicitHtmlFilePath(value: string): string | null {
  const literal = value.split('#', 1)[0];
  if (!literal || literal.includes('?') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(literal)
    || /^\/(?:api|public|_next)\//u.test(literal)) return null;
  let path: string;
  try { path = decodeURIComponent(literal); } catch { return null; }
  if (!path || /[\p{Cc}\p{Cf}\\]/u.test(path) || path.includes('?')
    || path.startsWith('/') && !literal.startsWith('/')
    || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(path)
    || /\/$|(?:^|\/)\.{1,2}$/u.test(path)) return null;
  return path;
}

export type WorkspaceHtmlLinkEvaluation = {
  unevaluated: boolean;
  /** Decoded file paths with fragments removed; present only for a fully inspected static HTML node. */
  explicitLocalTargets?: string[];
};

/** Classify original attributes without HTML tree repair or changing the source bytes. */
export function evaluateWorkspaceHtmlLinks(html: string): WorkspaceHtmlLinkEvaluation {
  let unevaluated = false;
  let fullyInspected = true;
  const explicitLocalTargets: string[] = [];
  const unsupported = () => { unevaluated = true; fullyInspected = false; };
  const ignore = () => {};
  const tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, {
    onStartTag: (token) => {
      if (UNSUPPORTED_HTML_TAG.test(token.tagName)) unsupported();
      if (!STATIC_HTML_TAGS.has(token.tagName)) fullyInspected = false;
      for (const attribute of token.attrs) {
        const { name } = attribute;
        const value = attribute.value.trim();
        if (!STATIC_GLOBAL_ATTRIBUTES.has(name) && !STATIC_TAG_ATTRIBUTES[token.tagName]?.has(name)
          && !/^aria-[a-z][a-z-]*$/u.test(name) && !SINGLE_URL_ATTRIBUTE.test(name)
          && !UNSUPPORTED_URL_ATTRIBUTE.test(name)) fullyInspected = false;
        if (UNSUPPORTED_URL_ATTRIBUTE.test(name)
          || /^on[a-z]/u.test(name)
          || name === 'style' && !isStaticHtmlLayoutStyle(value)) {
          unsupported();
          continue;
        }
        if (!SINGLE_URL_ATTRIBUTE.test(name)) continue;
        if (!value || getCanvasNotebookMarkdownLinkTarget(value)) {
          unsupported();
          continue;
        }
        if (value.startsWith('#')) continue;
        if (/^(?:https?:|mailto:|data:|\/\/)/iu.test(value)) continue;
        unevaluated = true;
        const simpleAttribute = token.tagName === 'img' && name === 'src'
          || token.tagName === 'a' && name === 'href';
        const location = token.location?.attrs?.[name];
        const originalValue = location ? rawAttributeValue(html.slice(location.startOffset, location.endOffset)) : null;
        const sameInterpretation = originalValue !== null && proseEntities(originalValue) === attribute.value
          && attribute.value === value;
        const path = simpleAttribute && sameInterpretation ? explicitHtmlFilePath(value) : null;
        if (path === null) fullyInspected = false;
        else explicitLocalTargets.push(path);
      }
    },
    onParseError: unsupported,
    onEndTag: ignore,
    onComment: ignore,
    onDoctype: ignore,
    onEof: ignore,
    onCharacter: ignore,
    onNullCharacter: ignore,
    onWhitespaceCharacter: ignore,
  });
  tokenizer.write(html, true);
  return { unevaluated, ...(unevaluated && fullyInspected && explicitLocalTargets.length
    ? { explicitLocalTargets } : {}) };
}

/** Compatibility query: explicit local HTML still requires an operation-specific safety assessment. */
export function hasUnevaluatedWorkspaceHtmlLinks(html: string): boolean {
  return evaluateWorkspaceHtmlLinks(html).unevaluated;
}
