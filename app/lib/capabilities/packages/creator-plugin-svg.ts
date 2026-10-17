import 'server-only';

import { SaxesParser, type SaxesTagNS } from 'saxes';
import { CAPABILITY_PACKAGE_ICON_MAX_BYTES, supportedImage } from './package-icon-image';

export type CreatorPluginSvgIssue = Readonly<{
  code: string;
  file: string;
  field: 'interface.logo';
  message: string;
  repair: string;
}>;

const svgNamespace = 'http://www.w3.org/2000/svg';
const xlinkNamespace = 'http://www.w3.org/1999/xlink';
const xmlnsNamespace = 'http://www.w3.org/2000/xmlns/';
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';
const elements = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath', 'use', 'symbol', 'linearGradient', 'radialGradient', 'stop', 'clipPath',
  'mask', 'marker', 'pattern',
]);
const attributes = new Set([
  'id', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'focusable',
  'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy',
  'r', 'rx', 'ry', 'd', 'points', 'transform', 'opacity', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'clip-rule', 'clip-path', 'clipPathUnits', 'mask',
  'maskUnits', 'maskContentUnits', 'marker-start', 'marker-mid', 'marker-end', 'markerWidth',
  'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'patternUnits', 'patternContentUnits',
  'patternTransform', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'fx', 'fy', 'fr',
  'offset', 'stop-color', 'stop-opacity', 'color', 'vector-effect', 'paint-order', 'shape-rendering',
  'text-rendering', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'font-stretch', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift',
  'letter-spacing', 'word-spacing', 'text-decoration', 'direction', 'unicode-bidi', 'dx', 'dy',
  'rotate', 'textLength', 'lengthAdjust', 'startOffset', 'method', 'spacing', 'href', 'display',
  'visibility', 'overflow',
]);
const referenceAttributes = new Set(['fill', 'stroke', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end']);
const numberToken = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const numberSeparator = '(?:[\\x20\\t\\r\\n]+|[\\x20\\t\\r\\n]*,[\\x20\\t\\r\\n]*)';
const viewBoxPattern = new RegExp(`^${numberToken}${numberSeparator}${numberToken}${numberSeparator}${numberToken}${numberSeparator}${numberToken}$`, 'u');
const fragmentPattern = /^#([A-Za-z_][A-Za-z0-9_.:-]*)$/u;
const localUrlPattern = /^url\(\s*(?:"#([A-Za-z_][A-Za-z0-9_.:-]*)"|'#([A-Za-z_][A-Za-z0-9_.:-]*)'|#([A-Za-z_][A-Za-z0-9_.:-]*))\s*\)$/u;

function meaningfulViewBox(tag: SaxesTagNS): boolean {
  const value = tag.attributes.viewBox?.value.trim() ?? '';
  if (!viewBoxPattern.test(value)) return false;
  const values = value.split(/[\x20\t\r\n,]+/u).map(Number);
  return values.every(Number.isFinite) && values[2] > 0 && values[3] > 0
    && Number.isFinite(values[0] + values[2]) && Number.isFinite(values[1] + values[3]);
}

/** Validate freshly captured bytes only. The caller retains package Read, inventory and revision authority. */
export function validateCreatorPluginSvg(bytes: Buffer, file: string): readonly CreatorPluginSvgIssue[] {
  const issues: CreatorPluginSvgIssue[] = [];
  const add = (code: string, message: string, repair: string) => {
    if (!issues.some(issue => issue.code === code)) issues.push({code, file, field: 'interface.logo', message, repair});
  };
  const relative = file.startsWith('./') ? file.slice(2) : file;
  if (!relative || relative.length > 1024 || /[\p{Cc}\p{Cf}\\]/u.test(relative)
    || relative.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..') || !relative.endsWith('.svg')) {
    add('CREATOR_SVG_PATH_INVALID', 'The purpose image must have a package-relative SVG path.', 'Write assets/logo.svg and set interface.logo to ./assets/logo.svg.');
    return issues;
  }
  if (!bytes.length || bytes.length > CAPABILITY_PACKAGE_ICON_MAX_BYTES) {
    add('CREATOR_SVG_SIZE_INVALID', 'The purpose SVG must contain at most 2 MiB of image bytes.', 'Write a nonempty, compact SVG no larger than 2 MiB.');
    return issues;
  }
  let xml: string;
  try { xml = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch {
    add('CREATOR_SVG_XML_INVALID', 'The purpose SVG is not valid UTF-8 XML.', 'Encode the complete SVG document as UTF-8.');
    return issues;
  }
  const parser = new SaxesParser({xmlns: true});
  const stack: string[] = [];
  const ids = new Set<string>();
  const references = new Set<string>();
  const metadata: Record<'title' | 'desc', string[]> = {title: [], desc: []};
  let currentMetadata: 'title' | 'desc' | undefined;
  let elementCount = 0;
  const abort = Symbol('invalid-svg');
  parser.on('error', () => {
    add('CREATOR_SVG_XML_INVALID', 'The purpose SVG is not a complete, well-formed XML document.', 'Repair XML nesting, quotes and character references; keep exactly one SVG root without trailing content.');
    throw abort;
  });
  parser.on('xmldecl', declaration => {
    if (declaration.encoding && declaration.encoding.toLowerCase() !== 'utf-8') {
      add('CREATOR_SVG_XML_INVALID', 'The purpose SVG declares an unsupported text encoding.', 'Use UTF-8 bytes and omit the encoding declaration or declare UTF-8.');
    }
  });
  parser.on('doctype', () => {
    add('CREATOR_SVG_PASSIVE_REQUIRED', 'The purpose SVG cannot contain a document type or entity declarations.', 'Remove the DOCTYPE and entities; use literal XML text or built-in character references.');
    throw abort;
  });
  parser.on('processinginstruction', () => {
    add('CREATOR_SVG_PASSIVE_REQUIRED', 'The purpose SVG cannot contain processing instructions.', 'Remove processing instructions and keep all drawing information in static SVG elements.');
  });
  parser.on('opentag', tag => {
    elementCount += 1;
    if (stack.length >= 128 || elementCount > 10_000) {
      add('CREATOR_SVG_COMPLEXITY_LIMIT', 'The purpose SVG exceeds the static image complexity limit.', 'Simplify the image to at most 128 nested elements and 10,000 elements in total.');
      throw abort;
    }
    if (!stack.length) {
      if (tag.local !== 'svg' || tag.uri !== svgNamespace) {
        add('CREATOR_SVG_NAMESPACE_INVALID', 'The document root must be svg in the SVG namespace.', 'Use <svg xmlns="http://www.w3.org/2000/svg"> as the document root.');
      }
      if (!meaningfulViewBox(tag)) {
        add('CREATOR_SVG_VIEWBOX_INVALID', 'The purpose SVG needs a finite viewBox with positive width and height.', 'Set four finite viewBox numbers, for example viewBox="0 0 256 256".');
      }
    }
    if (tag.uri !== svgNamespace || !elements.has(tag.local)) {
      add('CREATOR_SVG_PASSIVE_REQUIRED', 'The purpose SVG contains an unsupported or active element.', 'Use static SVG shapes, groups, text, gradients and local fragment references; remove styles, animation, links and embedded resources.');
    }
    if (currentMetadata) {
      add('CREATOR_SVG_METADATA_INVALID', 'The root title and description must contain plain text.', 'Write meaningful text directly inside a root-level title and desc.');
    }
    if (stack.length === 1 && (tag.local === 'title' || tag.local === 'desc') && tag.uri === svgNamespace) {
      currentMetadata = tag.local;
      metadata[currentMetadata].push('');
    }
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === xmlnsNamespace) {
        if (![svgNamespace, xlinkNamespace].includes(attribute.value)) {
          add('CREATOR_SVG_NAMESPACE_INVALID', 'The purpose SVG declares an unsupported namespace.', 'Keep only the SVG namespace and, if used for local references, the XLink namespace.');
        }
        continue;
      }
      const xmlText = attribute.uri === xmlNamespace && ['lang', 'space'].includes(attribute.local);
      const href = attribute.local === 'href' && (!attribute.uri || attribute.uri === xlinkNamespace);
      if (!xmlText && !(href || (!attribute.uri && attributes.has(attribute.local)))) {
        add('CREATOR_SVG_PASSIVE_REQUIRED', 'The purpose SVG contains an unsupported attribute.', 'Remove event handlers, style, external namespaces and unsupported attributes; use static presentation attributes.');
      }
      if (attribute.local === 'id' && !attribute.uri) {
        if (ids.has(attribute.value)) add('CREATOR_SVG_REFERENCE_INVALID', 'The purpose SVG contains duplicate IDs.', 'Give each referenced SVG element a unique ID.');
        ids.add(attribute.value);
      }
      if (href) {
        const reference = fragmentPattern.exec(attribute.value);
        if (reference) references.add(reference[1]);
        else add('CREATOR_SVG_PASSIVE_REQUIRED', 'The purpose SVG references a nonlocal resource.', 'Use only #fragment references to IDs in the same SVG; remove remote, file and data URLs.');
      }
      // CSS is intentionally limited to static presentation values, without escape/comment rewriting.
      if (!xmlText && attribute.uri !== xmlnsNamespace && !['id', 'aria-label', 'aria-labelledby', 'aria-describedby'].includes(attribute.local)
        && (/\\|\/\*|\*\/|@|[\p{Cc}\p{Cf}]/u.test(attribute.value) || /(?:url\s*\(|expression\s*\(|(?:https?|data|file|javascript):)/iu.test(attribute.value))) {
        const reference = referenceAttributes.has(attribute.local) && !attribute.uri ? localUrlPattern.exec(attribute.value) : null;
        if (reference) references.add(reference[1] ?? reference[2] ?? reference[3]);
        else add('CREATOR_SVG_PASSIVE_REQUIRED', 'The purpose SVG contains unsafe CSS or a nonlocal resource value.', 'Use plain presentation values or an exact url(#local-id) reference; remove CSS escapes, imports and resource URLs.');
      }
    }
    stack.push(tag.local);
  });
  const text = (value: string) => {
    if (currentMetadata && stack.length === 2) {
      const values = metadata[currentMetadata];
      values[values.length - 1] += value;
    }
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    if (stack.length === 2) currentMetadata = undefined;
    stack.pop();
  });
  try { parser.write(xml).close(); }
  catch {
    if (!issues.length) {
      add('CREATOR_SVG_XML_INVALID', 'The purpose SVG is not a complete, well-formed XML document.', 'Repair XML nesting, quotes and character references; keep exactly one SVG root without trailing content.');
    }
    return issues;
  }
  for (const key of ['title', 'desc'] as const) {
    if (metadata[key].length !== 1 || !/[\p{L}\p{N}]/u.test(metadata[key][0]?.trim() ?? '')) {
      add(key === 'title' ? 'CREATOR_SVG_TITLE_REQUIRED' : 'CREATOR_SVG_DESCRIPTION_REQUIRED',
        `The purpose SVG needs one meaningful root-level ${key}.`, `Add a plain-text ${key} describing the plugin's purpose or useful result.`);
    }
  }
  if ([...references].some(reference => !ids.has(reference))) {
    add('CREATOR_SVG_REFERENCE_INVALID', 'The purpose SVG references an ID absent from this document.', 'Create the referenced local element or remove the broken fragment reference.');
  }
  if (!supportedImage(bytes, 'image/svg+xml')) {
    add('CREATOR_SVG_PASSIVE_REQUIRED', 'The purpose SVG does not satisfy the existing passive package-image check.', 'Use an unprefixed svg root, static SVG markup and local fragment references compatible with package image presentation.');
  }
  return issues;
}
