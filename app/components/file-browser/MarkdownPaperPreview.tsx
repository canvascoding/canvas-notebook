'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type PaperSize = 'A4' | 'Letter';

type PaperLayout = {
  heightMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  marginTopMm: number;
  size: PaperSize;
  widthMm: number;
};

type PaperPage = {
  content: HTMLDivElement;
  layout: PaperLayout;
  page: HTMLElement;
  slot: HTMLDivElement;
};

const MM_TO_CSS_PIXELS = 96 / 25.4;
const DEFAULT_LAYOUT: PaperLayout = {
  size: 'A4',
  widthMm: 210,
  heightMm: 297,
  marginTopMm: 20,
  marginRightMm: 20,
  marginBottomMm: 20,
  marginLeftMm: 20,
};
const LANDSCAPE_MARGIN_MM = 15;
const PREVIEW_CSP = "default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

const PAPER_PREVIEW_CSS = `
  html, body {
    background: #e6eaf0 !important;
    margin: 0 !important;
    min-height: 100%;
    padding: 0 !important;
  }

  body {
    overflow: auto;
  }

  .canvas-paper-preview-stage {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 18px;
    min-height: 100%;
    padding: 18px 12px 28px;
  }

  .canvas-paper-preview-slot {
    flex: 0 0 auto;
    position: relative;
  }

  .canvas-paper-preview-page {
    background: var(--brand-page-background, #ffffff);
    box-shadow: 0 12px 30px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.10);
    overflow: hidden;
    transform-origin: top left;
  }

  .canvas-paper-preview-page[data-overflowing-page="true"] {
    height: auto !important;
    min-height: 100%;
    overflow: visible;
  }

  .canvas-paper-preview-content {
    box-sizing: border-box;
    height: 100%;
    width: 100%;
  }

  .canvas-paper-preview-content pre {
    overflow: hidden;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .canvas-paper-preview-content a[href]::after {
    color: #666;
    content: " (" attr(href) ")";
    font-size: 0.85em;
  }

  .canvas-paper-preview-content a[href^="#"]::after,
  .canvas-paper-preview-content a[href^="data:"]::after {
    content: "";
  }

  @media (prefers-reduced-motion: reduce) {
    .canvas-paper-preview-page {
      scroll-behavior: auto;
    }
  }
`;

function parseMargin(value: string | undefined): Pick<PaperLayout, 'marginTopMm' | 'marginRightMm' | 'marginBottomMm' | 'marginLeftMm'> {
  const values = Array.from(value?.matchAll(/(-?\d+(?:\.\d+)?)mm/giu) ?? [], (match) => Number(match[1]))
    .filter((margin) => Number.isFinite(margin) && margin >= 0);

  if (values.length === 1) {
    return {
      marginTopMm: values[0], marginRightMm: values[0], marginBottomMm: values[0], marginLeftMm: values[0],
    };
  }
  if (values.length === 2) {
    return {
      marginTopMm: values[0], marginRightMm: values[1], marginBottomMm: values[0], marginLeftMm: values[1],
    };
  }
  if (values.length === 3) {
    return {
      marginTopMm: values[0], marginRightMm: values[1], marginBottomMm: values[2], marginLeftMm: values[1],
    };
  }
  if (values.length >= 4) {
    return {
      marginTopMm: values[0], marginRightMm: values[1], marginBottomMm: values[2], marginLeftMm: values[3],
    };
  }

  return {
    marginTopMm: DEFAULT_LAYOUT.marginTopMm,
    marginRightMm: DEFAULT_LAYOUT.marginRightMm,
    marginBottomMm: DEFAULT_LAYOUT.marginBottomMm,
    marginLeftMm: DEFAULT_LAYOUT.marginLeftMm,
  };
}

/**
 * Reads the print settings from the exact document later passed to Chromium.
 * The last generic @page rule is the brand-specific override.
 */
export function getMarkdownPaperLayout(html: string): PaperLayout {
  const pageRules = Array.from(html.matchAll(/@page\s*\{([\s\S]*?)\}/giu), (match) => match[1]);
  const pageRule = pageRules.at(-1) ?? '';
  const size = /\bsize\s*:\s*(letter)\b/iu.test(pageRule) ? 'Letter' : 'A4';
  const dimensions = size === 'Letter'
    ? { widthMm: 215.9, heightMm: 279.4 }
    : { widthMm: 210, heightMm: 297 };
  const margin = /\bmargin\s*:\s*([^;]+);/iu.exec(pageRule)?.[1];

  return {
    size,
    ...dimensions,
    ...parseMargin(margin),
  };
}

export function createMarkdownPaperPreviewDocument(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const style = `<style data-canvas-paper-preview="true">${PAPER_PREVIEW_CSS}</style>`;
  const withHead = /<head\b[^>]*>/iu.test(html)
    ? html.replace(/<head\b[^>]*>/iu, (head) => `${head}${csp}${style}`)
    : `<!doctype html><html><head>${csp}${style}</head><body>${html}</body></html>`;

  return withHead;
}

function getLandscapeLayout(layout: PaperLayout): PaperLayout {
  return {
    ...layout,
    widthMm: layout.heightMm,
    heightMm: layout.widthMm,
    marginTopMm: LANDSCAPE_MARGIN_MM,
    marginRightMm: LANDSCAPE_MARGIN_MM,
    marginBottomMm: LANDSCAPE_MARGIN_MM,
    marginLeftMm: LANDSCAPE_MARGIN_MM,
  };
}

function isWhitespace(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && !(node.textContent || '').trim();
}

function isLandscapePage(node: Node): boolean {
  return node instanceof HTMLElement && node.classList.contains('markdown-wide-table-page');
}

function startsNewPage(node: Node, view: Window): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const style = view.getComputedStyle(node);
  return style.breakBefore === 'page' || style.pageBreakBefore === 'always';
}

function waitForPreviewAssets(document: Document): Promise<void> {
  const fontReady = document.fonts?.ready?.catch(() => undefined) ?? Promise.resolve();
  const imageReady = Promise.all(Array.from(document.images, (image) => {
    if (image.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    });
  }));
  const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, 1_000));

  return Promise.race([
    Promise.all([fontReady, imageReady]).then(() => undefined),
    timeout,
  ]);
}

function setPageScale(page: PaperPage, scale: number) {
  const width = page.layout.widthMm * MM_TO_CSS_PIXELS;
  const height = page.page.dataset.overflowingPage === 'true'
    ? page.page.scrollHeight
    : page.layout.heightMm * MM_TO_CSS_PIXELS;
  page.slot.style.width = `${width * scale}px`;
  page.slot.style.height = `${height * scale}px`;
  page.page.style.transform = `scale(${scale})`;
}

function hasDocumentContent(page: PaperPage): boolean {
  return page.content.querySelector('[data-canvas-paper-preview-item="true"]') !== null;
}

function addPaperPage(
  document: Document,
  stage: HTMLElement,
  layout: PaperLayout,
  scale: number,
  repeatHeader: HTMLElement | null,
  shouldRepeatHeader: boolean,
): PaperPage {
  const slot = document.createElement('div');
  slot.className = 'canvas-paper-preview-slot';
  const page = document.createElement('section');
  page.className = 'canvas-paper-preview-page';
  page.setAttribute('aria-label', `${layout.size} page`);
  page.style.width = `${layout.widthMm}mm`;
  page.style.height = `${layout.heightMm}mm`;
  const content = document.createElement('div');
  content.className = 'canvas-paper-preview-content';
  content.style.padding = `${layout.marginTopMm}mm ${layout.marginRightMm}mm ${layout.marginBottomMm}mm ${layout.marginLeftMm}mm`;

  if (shouldRepeatHeader && repeatHeader) {
    const header = repeatHeader.cloneNode(true) as HTMLElement;
    header.setAttribute('aria-hidden', 'true');
    content.append(header);
  }

  page.append(content);
  slot.append(page);
  stage.append(slot);
  const paperPage = { content, layout, page, slot };
  setPageScale(paperPage, scale);
  return paperPage;
}

function paginateDocument(iframe: HTMLIFrameElement) {
  const document = iframe.contentDocument;
  const view = iframe.contentWindow;
  if (!document || !view || document.body.dataset.canvasPaperPreviewPaginated === 'true') return 0;

  const layout = getMarkdownPaperLayout(document.documentElement.outerHTML);
  const availableWidth = Math.max(1, iframe.clientWidth - 24);
  const scale = Math.min(1, availableWidth / (layout.widthMm * MM_TO_CSS_PIXELS));
  const nodes = Array.from(document.body.childNodes).filter((node) => !isWhitespace(node));
  const repeatHeader = nodes.find((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains('canvas-brand-header')) ?? null;
  const stage = document.createElement('main');
  stage.className = 'canvas-paper-preview-stage';
  stage.setAttribute('aria-label', 'Print preview');
  document.body.replaceChildren(stage);

  let page = addPaperPage(document, stage, layout, scale, repeatHeader, false);

  for (const node of nodes) {
    const nodeLayout = isLandscapePage(node) ? getLandscapeLayout(layout) : layout;
    const shouldStartNewPage = (startsNewPage(node, view) || nodeLayout !== page.layout) && hasDocumentContent(page);
    if (shouldStartNewPage) {
      page = addPaperPage(document, stage, nodeLayout, scale, repeatHeader, stage.children.length > 0);
    }

    if (node instanceof HTMLElement) node.dataset.canvasPaperPreviewItem = 'true';
    page.content.append(node);

    if (page.content.scrollHeight > page.content.clientHeight + 1) {
      page.content.removeChild(node);
      if (hasDocumentContent(page)) {
        page = addPaperPage(document, stage, nodeLayout, scale, repeatHeader, true);
        page.content.append(node);
      } else {
        page.content.append(node);
      }

      if (page.content.scrollHeight > page.content.clientHeight + 1) {
        page.page.dataset.overflowingPage = 'true';
        setPageScale(page, scale);
      }
    }
  }

  document.body.dataset.canvasPaperPreviewPaginated = 'true';
  return stage.children.length;
}

interface MarkdownPaperPreviewProps {
  html: string;
  title: string;
}

export function MarkdownPaperPreview({ html, title }: MarkdownPaperPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadToken = useRef(0);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const sourceDocument = useMemo(() => createMarkdownPaperPreviewDocument(html), [html]);

  const scalePages = useCallback(() => {
    const iframe = iframeRef.current;
    const document = iframe?.contentDocument;
    if (!iframe || !document || document.body.dataset.canvasPaperPreviewPaginated !== 'true') return;

    const layout = getMarkdownPaperLayout(document.documentElement.outerHTML);
    const scale = Math.min(1, Math.max(1, iframe.clientWidth - 24) / (layout.widthMm * MM_TO_CSS_PIXELS));
    document.querySelectorAll<HTMLElement>('.canvas-paper-preview-page').forEach((page) => {
      const pageLayout = page.style.width === `${layout.heightMm}mm` ? getLandscapeLayout(layout) : layout;
      const slot = page.parentElement as HTMLDivElement | null;
      const content = page.querySelector<HTMLDivElement>('.canvas-paper-preview-content');
      if (!slot || !content) return;
      setPageScale({ page, slot, content, layout: pageLayout }, scale);
    });
  }, []);

  const handleLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const token = ++loadToken.current;
    setPageCount(null);

    void waitForPreviewAssets(iframe.contentDocument ?? document).then(() => {
      if (token !== loadToken.current) return;
      window.requestAnimationFrame(() => {
        if (token !== loadToken.current) return;
        const count = paginateDocument(iframe);
        if (count) setPageCount(count);
      });
    });
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const observer = new ResizeObserver(scalePages);
    observer.observe(iframe);
    return () => observer.disconnect();
  }, [scalePages]);

  return (
    <div className="relative h-full overflow-hidden rounded-md bg-slate-200 sm:rounded-lg">
      <iframe
        ref={iframeRef}
        srcDoc={sourceDocument}
        className="h-full w-full border-0"
        sandbox="allow-same-origin"
        title={title}
        onLoad={handleLoad}
      />
      {pageCount ? (
        <span className="pointer-events-none absolute bottom-3 right-3 rounded-full border border-slate-300/80 bg-white/90 px-2 py-1 text-[11px] font-medium text-slate-600 shadow-sm backdrop-blur">
          {pageCount} {pageCount === 1 ? 'Seite' : 'Seiten'}
        </span>
      ) : null}
    </div>
  );
}
