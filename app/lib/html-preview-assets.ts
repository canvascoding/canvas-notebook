import path from 'node:path';
import { JSDOM } from 'jsdom';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { getHtmlPreviewAssetContentType, isHtmlFile } from './html-preview';

const DOCUMENT_ORIGIN = 'https://canvas-document.invalid';
const MAX_FILES = 512;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const TEXT_ASSET = /\.(?:html?|css|[cm]?js|svg)$/iu;

export type HtmlPreviewAssetReader = {
  read(filePath: string): Promise<Buffer>;
  list(directory: string): Promise<Array<{ path: string; type: 'file' | 'directory' }>>;
};

export function normalizeHtmlPreviewPath(value: string): string {
  if (!value || value.length > 1000 || value.startsWith('/') || /[\\\u0000-\u001f\u007f]/u.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('Invalid HTML preview path');
  }
  return value;
}

function sourceUrl(filePath: string): URL {
  return new URL('/' + filePath.split('/').map(encodeURIComponent).join('/'), DOCUMENT_ORIGIN);
}

function decodeScriptString(literal: string): string | null {
  if (literal.length < 2 || !['"', "'", '`'].includes(literal[0]) || literal.at(-1) !== literal[0]) return null;
  if (literal[0] === '`' && literal.includes('${')) return null;
  try {
    return literal.slice(1, -1).replace(/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|([\s\S]))/giu, (_match, point, unicode, hex, escaped) => {
      if (point || unicode || hex) return String.fromCodePoint(Number.parseInt(point || unicode || hex, 16));
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\n': '' } as Record<string, string>)[escaped] ?? escaped;
    });
  } catch { return null; }
}

function scriptReferences(script: string): string[] {
  const references: string[] = [];
  javascriptLanguage.parser.parse(script).iterate({ enter(node) {
    if (node.name !== 'String' && node.name !== 'TemplateString') return;
    const literal = script.slice(node.from, node.to);
    const value = decodeScriptString(literal);
    if (value !== null) references.push(value);
    else if (node.name === 'TemplateString') {
      // Dynamic data/worker filenames can use a declared subdirectory. The
      // server expands that specific directory into a finite file manifest.
      const prefix = literal.slice(1, literal.indexOf('${'));
      if (prefix.endsWith('/')) references.push(prefix);
    }
  } });
  return references;
}

function cssReferences(css: string): string[] {
  const values: string[] = [];
  for (const match of css.matchAll(/url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s)]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/giu)) {
    const value = match.slice(1).find(value => value !== undefined) || '';
    values.push(value.replace(/\\([\da-f]{1,6})\s?|\\([^\r\n])/giu, (_match, hex, character) => hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : character));
  }
  return values;
}

function documentReferences(text: string, filePath: string): Array<{ value: string; base: URL }> {
  const ownUrl = sourceUrl(filePath);
  if (/\.[cm]?js$/iu.test(filePath)) return scriptReferences(text).map(value => ({value, base:ownUrl}));
  if (/\.css$/iu.test(filePath)) return cssReferences(text).map(value => ({value, base:ownUrl}));
  // JSDOM parses only. No script execution or external resource loader is enabled.
  const dom = new JSDOM(text, { url: ownUrl.href });
  try {
    const document = dom.window.document;
    const base = new URL(document.baseURI);
    const references: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of ['src', 'href', 'xlink:href', 'poster', 'data']) {
        if (element.hasAttribute(attribute)) references.push(element.getAttribute(attribute)!);
      }
      if (element.hasAttribute('srcset')) {
        for (const part of element.getAttribute('srcset')!.split(',')) references.push(part.trim().split(/\s/u)[0]);
      }
      if (element.hasAttribute('style')) references.push(...cssReferences(element.getAttribute('style')!));
    }
    for (const element of document.querySelectorAll('style')) references.push(...cssReferences(element.textContent || ''));
    for (const element of document.querySelectorAll('script:not([src])')) references.push(...scriptReferences(element.textContent || ''));
    return references.map(value => ({value, base}));
  } finally { dom.window.close(); }
}

/** Freeze declared dependencies; a missing/ambiguous reference never grants a workspace. */
export async function buildHtmlPreviewAssetManifest(rootHtmlPath: string, reader: HtmlPreviewAssetReader): Promise<string[]> {
  normalizeHtmlPreviewPath(rootHtmlPath);
  if (!isHtmlFile(rootHtmlPath)) throw new Error('HTML document required');
  const allowed = new Set<string>([rootHtmlPath]);
  const pending = [rootHtmlPath];
  const expanded = new Set<string>();
  const documentDirectory = path.posix.dirname(rootHtmlPath);
  let textBytes = 0;
  const add = (filePath: string) => {
    normalizeHtmlPreviewPath(filePath);
    if (getHtmlPreviewAssetContentType(filePath) === 'application/octet-stream' && !isHtmlFile(filePath)) return;
    if (allowed.has(filePath)) return;
    if (allowed.size >= MAX_FILES) throw new Error('HTML preview has too many assets');
    allowed.add(filePath);
    if (TEXT_ASSET.test(filePath)) pending.push(filePath);
  };
  const expandDirectory = async (directory: string, depth = 0): Promise<void> => {
    // Only a specifically named subdirectory of the document area can be
    // expanded for dynamic paths. The document/workspace root never qualifies.
    if (directory === documentDirectory || directory === '.' || expanded.has(directory)) return;
    if (documentDirectory !== '.' && !directory.startsWith(documentDirectory + '/')) return;
    if (depth > 8 || expanded.size >= 64) throw new Error('HTML preview asset directory is too large');
    normalizeHtmlPreviewPath(directory);
    expanded.add(directory);
    let entries: Awaited<ReturnType<HtmlPreviewAssetReader['list']>>;
    try { entries = await reader.list(directory); } catch { return; }
    for (const entry of entries) {
      if (!entry.path.startsWith(directory + '/') || entry.path.split('/').some(part => part.startsWith('.'))) continue;
      if (entry.type === 'directory') await expandDirectory(entry.path, depth + 1);
      else add(entry.path);
    }
  };
  while (pending.length) {
    const filePath = pending.shift()!;
    let content: Buffer;
    try { content = await reader.read(filePath); } catch (error) {
      if (filePath === rootHtmlPath) throw error;
      continue;
    }
    textBytes += content.length;
    if (textBytes > MAX_TEXT_BYTES) throw new Error('HTML preview source is too large');
    for (const {value, base} of documentReferences(content.toString('utf8'), filePath)) {
      if (!value || /^(?:#|data:|blob:|javascript:)/iu.test(value)) continue;
      let url: URL;
      let candidate: string;
      try {
        url = new URL(value, base);
        if (url.origin !== DOCUMENT_ORIGIN || url.username || url.password) continue;
        candidate = decodeURIComponent(url.pathname.slice(1)).replace(/\/$/u, '');
        normalizeHtmlPreviewPath(candidate);
      } catch { continue; }
      if (value.endsWith('/') && !value.startsWith('/')) await expandDirectory(candidate);
      else add(candidate);
    }
  }
  return [...allowed].sort();
}

function ticketRootUrl(value: string, routePrefix: string) {
  return value.startsWith('/') && !value.startsWith('//') ? routePrefix + value : value;
}

export function rewriteHtmlPreviewCss(css: string, routePrefix: string) {
  return css.replace(/url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s)]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/giu, (match, ...groups) => {
    const value = groups.slice(0,5).find(value => value !== undefined) || '';
    return value ? match.replace(value,ticketRootUrl(value,routePrefix)) : match;
  });
}

export function rewriteHtmlPreviewScript(script: string, routePrefix: string) {
  const changes: Array<{from:number;to:number;text:string}> = [];
  javascriptLanguage.parser.parse(script).iterate({enter(node) {
    if (node.name !== 'String' && node.name !== 'TemplateString') return;
    const literal = script.slice(node.from,node.to);
    const value = decodeScriptString(literal);
    if (value?.startsWith('/') && !value.startsWith('//') && value !== '/') {
      const filePath = new URL(value,DOCUMENT_ORIGIN).pathname;
      if (value.endsWith('/') || isHtmlFile(filePath) || getHtmlPreviewAssetContentType(filePath) !== 'application/octet-stream') {
        changes.push({from:node.from,to:node.to,text:JSON.stringify(ticketRootUrl(value,routePrefix))});
      }
    } else if (node.name === 'TemplateString' && literal.startsWith('`/') && !literal.startsWith('`//') && literal.includes('${')) {
      const prefix = literal.slice(1,literal.indexOf('${'));
      if (prefix.length > 1 && prefix.endsWith('/')) changes.push({from:node.from,to:node.from+1,text:'`'+routePrefix});
    }
  }});
  for (const change of changes.sort((a,b)=>b.from-a.from)) script=script.slice(0,change.from)+change.text+script.slice(change.to);
  return script;
}

/** Preserve root-relative assets inside the ticket namespace as well as ordinary relative URLs. */
export function rewriteHtmlPreviewDocument(html: string, filePath: string, routePrefix: string) {
  const dom = new JSDOM(html);
  try {
    const document=dom.window.document;
    for(const element of document.querySelectorAll('*')) {
      for(const name of ['src','href','xlink:href','poster','data']) {
        if(element.hasAttribute(name)) element.setAttribute(name,ticketRootUrl(element.getAttribute(name)!,routePrefix));
      }
      if(element.hasAttribute('srcset')) element.setAttribute('srcset',element.getAttribute('srcset')!.replace(/(^|,)\s*(\/[^\s,]+)/gu,(_match,separator,url)=>separator+' '+ticketRootUrl(url,routePrefix)));
      if(element.hasAttribute('style')) element.setAttribute('style',rewriteHtmlPreviewCss(element.getAttribute('style')!,routePrefix));
    }
    for(const element of document.querySelectorAll('style')) element.textContent=rewriteHtmlPreviewCss(element.textContent||'',routePrefix);
    for(const element of document.querySelectorAll('script:not([src])')) element.textContent=rewriteHtmlPreviewScript(element.textContent||'',routePrefix);
    if(!document.querySelector('base[href]')) {
      const base=document.createElement('base');
      const parent=filePath.split('/').slice(0,-1).map(encodeURIComponent).join('/');
      base.setAttribute('href',routePrefix+'/'+(parent ? parent+'/' : ''));
      document.head.prepend(base);
    }
    if(!document.querySelector('meta[name="viewport" i]')) {
      const viewport=document.createElement('meta');viewport.name='viewport';viewport.content='width=device-width, initial-scale=1';document.head.prepend(viewport);
    }
    return dom.serialize();
  } finally { dom.window.close(); }
}
