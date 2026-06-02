import 'server-only';

import { Marp } from '@marp-team/marp-core';
import path from 'path';
import { readFile } from '@/app/lib/filesystem/workspace-files';

const MAX_ASSET_INLINE_SIZE = 5 * 1024 * 1024;

type HtmlAttributeAllowList = Record<string, boolean | ((value: string) => string)>;
type HtmlAllowList = Record<string, string[] | HtmlAttributeAllowList>;

const MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

const GLOBAL_HTML_ATTRIBUTES = [
  'class',
  'dir',
  'height',
  'id',
  'lang',
  'style',
  'title',
  'width',
];

function isSafeLinkUrl(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:https?:|mailto:|tel:|#|\/(?!\/)|\.{0,2}\/|[^:/?#]+(?:[/?#]|$))/i.test(trimmed);
}

function isSafeMediaUrl(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:https?:|data:image\/|#|\/(?!\/)|\.{0,2}\/|[^:/?#]+(?:[/?#]|$))/i.test(trimmed);
}

function sanitizeLinkUrl(value: string): string {
  return isSafeLinkUrl(value) ? value : '';
}

function sanitizeMediaUrl(value: string): string {
  return isSafeMediaUrl(value) ? value : '';
}

function allowAttributes(
  attributes: string[],
  sanitizers: HtmlAttributeAllowList = {}
) {
  return { ...Object.fromEntries(attributes.map((attribute) => [attribute, true])), ...sanitizers };
}

const HTML_ALLOWLIST: HtmlAllowList = {
  a: allowAttributes([...GLOBAL_HTML_ATTRIBUTES, 'name', 'rel', 'target'], { href: sanitizeLinkUrl }),
  abbr: GLOBAL_HTML_ATTRIBUTES,
  b: GLOBAL_HTML_ATTRIBUTES,
  blockquote: GLOBAL_HTML_ATTRIBUTES,
  br: [],
  cite: GLOBAL_HTML_ATTRIBUTES,
  code: GLOBAL_HTML_ATTRIBUTES,
  dd: GLOBAL_HTML_ATTRIBUTES,
  del: GLOBAL_HTML_ATTRIBUTES,
  details: [...GLOBAL_HTML_ATTRIBUTES, 'open'],
  div: GLOBAL_HTML_ATTRIBUTES,
  dl: GLOBAL_HTML_ATTRIBUTES,
  dt: GLOBAL_HTML_ATTRIBUTES,
  em: GLOBAL_HTML_ATTRIBUTES,
  figcaption: GLOBAL_HTML_ATTRIBUTES,
  figure: GLOBAL_HTML_ATTRIBUTES,
  h1: GLOBAL_HTML_ATTRIBUTES,
  h2: GLOBAL_HTML_ATTRIBUTES,
  h3: GLOBAL_HTML_ATTRIBUTES,
  h4: GLOBAL_HTML_ATTRIBUTES,
  h5: GLOBAL_HTML_ATTRIBUTES,
  h6: GLOBAL_HTML_ATTRIBUTES,
  hr: GLOBAL_HTML_ATTRIBUTES,
  i: GLOBAL_HTML_ATTRIBUTES,
  img: allowAttributes([...GLOBAL_HTML_ATTRIBUTES, 'alt', 'loading'], { src: sanitizeMediaUrl }),
  kbd: GLOBAL_HTML_ATTRIBUTES,
  li: GLOBAL_HTML_ATTRIBUTES,
  mark: GLOBAL_HTML_ATTRIBUTES,
  ol: [...GLOBAL_HTML_ATTRIBUTES, 'reversed', 'start', 'type'],
  p: GLOBAL_HTML_ATTRIBUTES,
  pre: GLOBAL_HTML_ATTRIBUTES,
  q: [...GLOBAL_HTML_ATTRIBUTES, 'cite'],
  s: GLOBAL_HTML_ATTRIBUTES,
  small: GLOBAL_HTML_ATTRIBUTES,
  span: GLOBAL_HTML_ATTRIBUTES,
  strong: GLOBAL_HTML_ATTRIBUTES,
  style: [],
  sub: GLOBAL_HTML_ATTRIBUTES,
  summary: GLOBAL_HTML_ATTRIBUTES,
  sup: GLOBAL_HTML_ATTRIBUTES,
  table: GLOBAL_HTML_ATTRIBUTES,
  tbody: GLOBAL_HTML_ATTRIBUTES,
  td: [...GLOBAL_HTML_ATTRIBUTES, 'colspan', 'rowspan'],
  tfoot: GLOBAL_HTML_ATTRIBUTES,
  th: [...GLOBAL_HTML_ATTRIBUTES, 'colspan', 'rowspan', 'scope'],
  thead: GLOBAL_HTML_ATTRIBUTES,
  tr: GLOBAL_HTML_ATTRIBUTES,
  u: GLOBAL_HTML_ATTRIBUTES,
  ul: GLOBAL_HTML_ATTRIBUTES,
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getMimeType(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return MIME_TYPES[extension] || 'application/octet-stream';
}

function isExternalOrSpecialUrl(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url);
}

function stripUrlDecorations(url: string): string {
  const hashIndex = url.indexOf('#');
  const queryIndex = url.indexOf('?');
  const splitIndexes = [hashIndex, queryIndex].filter((index) => index >= 0);
  const endIndex = splitIndexes.length > 0 ? Math.min(...splitIndexes) : url.length;
  return url.slice(0, endIndex);
}

function decodeUrlPath(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

async function resolveWorkspaceAssetDataUri(assetUrl: string, baseDir: string): Promise<string | null> {
  const trimmedUrl = assetUrl.trim();
  if (!trimmedUrl || isExternalOrSpecialUrl(trimmedUrl)) {
    return null;
  }

  const cleanUrl = decodeUrlPath(stripUrlDecorations(trimmedUrl));
  const workspacePath = cleanUrl.startsWith('/')
    ? cleanUrl.replace(/^\/+/, '')
    : path.join(baseDir, cleanUrl);
  const normalizedWorkspacePath = path.normalize(workspacePath).replace(/\\/g, '/');

  try {
    const buffer = await readFile(normalizedWorkspacePath);
    if (buffer.length > MAX_ASSET_INLINE_SIZE) {
      console.warn(`[Marp] Asset too large to inline: ${normalizedWorkspacePath}`);
      return null;
    }

    return `data:${getMimeType(normalizedWorkspacePath)};base64,${buffer.toString('base64')}`;
  } catch (error) {
    console.warn('[Marp] Failed to inline asset:', assetUrl, error);
    return null;
  }
}

async function inlineHtmlAssetSources(html: string, baseDir: string): Promise<string> {
  const sourceRegex = /(<(?:img|source|video|audio)\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi;
  const matches = Array.from(html.matchAll(sourceRegex));
  let nextHtml = html;

  for (const match of matches) {
    const [fullMatch, before, source, after] = match;
    const dataUri = await resolveWorkspaceAssetDataUri(source, baseDir);
    if (dataUri) {
      nextHtml = nextHtml.replace(fullMatch, `${before}${dataUri}${after}`);
    }
  }

  return nextHtml;
}

async function inlineCssUrls(css: string, baseDir: string): Promise<string> {
  const urlRegex = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  const matches = Array.from(css.matchAll(urlRegex));
  let nextCss = css;

  for (const match of matches) {
    const [fullMatch, _quote, source] = match;
    const dataUri = await resolveWorkspaceAssetDataUri(source, baseDir);
    if (dataUri) {
      nextCss = nextCss.replace(fullMatch, `url("${dataUri}")`);
    }
  }

  return nextCss;
}

function createMarpRenderer() {
  return new Marp({
    html: HTML_ALLOWLIST,
    script: true,
  });
}

export async function renderMarpMarkdownToHtmlDocument(
  markdown: string,
  options: {
    filePath: string;
    title?: string;
  }
): Promise<string> {
  const baseDir = path.dirname(options.filePath);
  const marp = createMarpRenderer();
  const rendered = marp.render(markdown);
  const html = await inlineHtmlAssetSources(rendered.html, baseDir);
  const css = await inlineCssUrls(rendered.css, baseDir);
  const title = options.title || path.basename(options.filePath);

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https:; img-src data: blob: https: http:; media-src data: blob: https: http:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'">
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
  <style>
    html,
    body {
      min-height: 100%;
      margin: 0;
      background: #111827;
    }

    body {
      box-sizing: border-box;
      padding: 24px;
      color: #111827;
      font-family: Arial, Helvetica, sans-serif;
    }

    .marpit {
      display: flex;
      min-height: calc(100vh - 48px);
      flex-direction: column;
      align-items: center;
      gap: 24px;
    }

    .marpit > svg {
      display: block;
      width: min(100%, 1280px);
      height: auto;
      background: #fff;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.32);
    }

    @media (max-width: 720px) {
      body {
        padding: 12px;
      }

      .marpit {
        min-height: calc(100vh - 24px);
        gap: 12px;
      }
    }

    @media print {
      html,
      body {
        background: #fff;
        padding: 0;
      }

      .marpit {
        display: block;
        min-height: 0;
      }

      .marpit > svg {
        width: 100%;
        box-shadow: none;
        page-break-after: always;
      }
    }
  </style>
</head>
<body>
${html}
</body>
</html>`;
}
