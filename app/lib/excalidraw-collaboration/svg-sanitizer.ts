import 'server-only';

import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

type DOMPurifyWindow = Parameters<typeof createDOMPurify>[0];

const purifierWindow = new JSDOM('').window as unknown as DOMPurifyWindow;
const svgPurifier = createDOMPurify(purifierWindow);

const SVG_SANITIZE_CONFIG = {
  USE_PROFILES: {
    svg: true,
    svgFilters: true,
  },
} as const;

export function sanitizeExcalidrawSvg(buffer: Buffer): Buffer {
  const source = buffer.toString('utf8').replace(/^\uFEFF/u, '').trimStart();
  if (!/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(source)) {
    throw new Error('SVG content does not match MIME type.');
  }

  const sanitized = svgPurifier.sanitize(source, SVG_SANITIZE_CONFIG);
  const parsed = new JSDOM(sanitized, { contentType: 'image/svg+xml' });
  const root = parsed.window.document.documentElement;
  if (
    root.localName !== 'svg'
    || root.namespaceURI && root.namespaceURI !== 'http://www.w3.org/2000/svg'
  ) {
    throw new Error('SVG content does not match MIME type.');
  }

  return Buffer.from(sanitized, 'utf8');
}
