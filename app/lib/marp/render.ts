import 'server-only';

import { Marp } from '@marp-team/marp-core';
import fs from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { readFile, resolveExistingWorkspacePath } from '@/app/lib/filesystem/workspace-files';

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
  if (!trimmedUrl) {
    return null;
  }

  const normalizedWorkspacePath = await resolveWorkspaceAssetPath(trimmedUrl, baseDir);
  if (!normalizedWorkspacePath) {
    return null;
  }

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

async function resolveWorkspaceAssetPath(assetUrl: string, baseDir: string): Promise<string | null> {
  const appMediaPath = parseWorkspacePathFromAppMediaUrl(assetUrl);
  if (appMediaPath) {
    return normalizeWorkspacePath(appMediaPath);
  }

  if (/^file:\/\//i.test(assetUrl)) {
    try {
      return resolveAbsoluteWorkspaceAssetPath(fileURLToPath(assetUrl));
    } catch {
      return null;
    }
  }

  const cleanUrl = decodeUrlPath(stripUrlDecorations(assetUrl));
  if (!cleanUrl || isExternalOrSpecialUrl(cleanUrl)) {
    return null;
  }

  if (path.isAbsolute(cleanUrl)) {
    const absoluteWorkspacePath = await resolveAbsoluteWorkspaceAssetPath(cleanUrl);
    if (absoluteWorkspacePath) {
      return absoluteWorkspacePath;
    }

    return normalizeWorkspacePath(cleanUrl.replace(/^\/+/, ''));
  }

  return normalizeWorkspacePath(path.join(baseDir, cleanUrl));
}

function parseWorkspacePathFromAppMediaUrl(assetUrl: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(assetUrl, 'http://canvas.local');
  } catch {
    return null;
  }

  if (parsed.origin !== 'http://canvas.local') {
    return null;
  }

  const pathPrefixes = ['/api/media/preview/', '/api/media/'];
  for (const prefix of pathPrefixes) {
    if (parsed.pathname.startsWith(prefix)) {
      return decodeUrlPath(parsed.pathname.slice(prefix.length));
    }
  }

  if (parsed.pathname === '/api/files/preview') {
    const filePath = parsed.searchParams.get('path');
    return filePath ? decodeUrlPath(filePath) : null;
  }

  return null;
}

async function resolveAbsoluteWorkspaceAssetPath(filePath: string): Promise<string | null> {
  try {
    const realWorkspaceRoot = await resolveExistingWorkspacePath('.');
    const realFilePath = await fs.realpath(filePath);
    const relativePath = path.relative(realWorkspaceRoot, realFilePath);

    if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null;
    }

    return normalizeWorkspacePath(relativePath);
  } catch {
    return null;
  }
}

function normalizeWorkspacePath(filePath: string): string {
  return path.normalize(filePath).replace(/\\/g, '/').replace(/^\.\/+/, '');
}

async function replaceAsync(
  input: string,
  regex: RegExp,
  replacer: (match: RegExpMatchArray) => Promise<string>
): Promise<string> {
  const matches = Array.from(input.matchAll(regex));
  if (matches.length === 0) {
    return input;
  }

  let result = '';
  let lastIndex = 0;

  for (const match of matches) {
    const index = match.index ?? 0;
    result += input.slice(lastIndex, index);
    result += await replacer(match);
    lastIndex = index + match[0].length;
  }

  return result + input.slice(lastIndex);
}

export async function inlineMarpMarkdownWorkspaceAssets(
  markdown: string,
  options: {
    filePath: string;
  }
): Promise<string> {
  const baseDir = path.dirname(options.filePath);

  let nextMarkdown = await replaceAsync(
    markdown,
    /(!\[[^\]\n]*\]\(\s*)(<[^>\n]+>|[^\s)\n]+)([^)\n]*\))/g,
    async (match) => {
      const before = match[1] ?? '';
      const rawSource = match[2] ?? '';
      const after = match[3] ?? '';
      const isAngled = rawSource.startsWith('<') && rawSource.endsWith('>');
      const source = isAngled ? rawSource.slice(1, -1) : rawSource;
      const dataUri = await resolveWorkspaceAssetDataUri(source, baseDir);

      if (!dataUri) {
        return match[0];
      }

      return `${before}${isAngled ? `<${dataUri}>` : dataUri}${after}`;
    }
  );

  nextMarkdown = await inlineCssUrls(nextMarkdown, baseDir);

  nextMarkdown = await replaceAsync(
    nextMarkdown,
    /(<(?:img|source|video|audio)\b[^>]*\b(?:src|poster)=["'])([^"']+)(["'][^>]*>)/gi,
    async (match) => {
      const before = match[1] ?? '';
      const source = match[2] ?? '';
      const after = match[3] ?? '';
      const dataUri = await resolveWorkspaceAssetDataUri(source, baseDir);

      if (!dataUri) {
        return match[0];
      }

      return `${before}${dataUri}${after}`;
    }
  );

  return nextMarkdown;
}

async function inlineHtmlAssetSources(html: string, baseDir: string): Promise<string> {
  const sourceRegex = /(<(?:img|source|video|audio)\b[^>]*\b(?:src|poster)=["'])([^"']+)(["'][^>]*>)/gi;
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

function wrapMarpSlides(html: string): string {
  let slideIndex = 0;

  return html.replace(/(<svg\b(?=[^>]*\bdata-marpit-svg\b)[\s\S]*?<\/svg>)/g, (svg) => {
    slideIndex += 1;
    return `<figure class="marp-slide-frame" data-marp-slide="${slideIndex}" aria-label="Slide ${slideIndex}"><div class="marp-slide-surface">${svg}</div><figcaption class="marp-slide-caption">Slide ${slideIndex}</figcaption></figure>`;
  });
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
  const html = wrapMarpSlides(await inlineHtmlAssetSources(rendered.html, baseDir));
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
      width: 100%;
      height: 100%;
      max-width: 100%;
      margin: 0;
      background: #111827;
      overflow-x: hidden;
    }

    body {
      box-sizing: border-box;
      min-width: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: clamp(10px, 3vw, 28px);
      color: #111827;
      font-family: Arial, Helvetica, sans-serif;
      -webkit-overflow-scrolling: touch;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    .marpit {
      display: flex;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      min-height: 100%;
      flex-direction: column;
      align-items: center;
      gap: clamp(14px, 3vw, 28px);
      overflow: visible;
    }

    .marp-slide-frame {
      display: grid;
      width: 100%;
      max-width: 1280px;
      min-width: 0;
      margin: 0;
      gap: 8px;
      justify-items: center;
      overflow: visible;
    }

    .marp-slide-surface {
      display: flex;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      overflow: visible;
      background: #fff;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.32);
    }

    .marp-slide-surface > svg,
    svg[data-marpit-svg],
    .marpit > svg {
      display: block;
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      height: auto !important;
      flex: 0 0 auto;
      background: #fff;
    }

    .marpit > svg {
      max-width: min(100%, 1280px) !important;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.32);
    }

    .marp-slide-caption {
      color: #cbd5e1;
      font-size: 12px;
      line-height: 1;
    }

    @media (max-width: 720px) {
      body {
        padding: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
      }

      .marpit {
        gap: 12px;
      }

      .marp-slide-frame {
        gap: 6px;
      }

      .marp-slide-surface {
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
      }

      .marp-slide-caption {
        font-size: 11px;
      }
    }

    @media print {
      @page {
        margin: 0;
      }

      html,
      body {
        background: #fff;
        padding: 0;
      }

      .marpit {
        display: block;
        min-height: 0;
      }

      .marp-slide-frame {
        display: block;
        width: 100%;
        break-after: page;
        page-break-after: always;
      }

      .marp-slide-surface,
      .marpit > svg {
        width: 100%;
        box-shadow: none;
      }

      .marp-slide-surface > svg,
      .marpit > svg {
        box-shadow: none;
      }

      .marp-slide-caption {
        display: none;
      }

      .marp-slide-frame:last-child {
        break-after: auto;
        page-break-after: auto;
      }
    }
  </style>
</head>
<body>
${html}
</body>
</html>`;
}
