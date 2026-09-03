import { proseEntities } from './prose-entities';

export type ImageAlignment = 'left' | 'center' | 'right';
export type PortableImage = {
  src: string;
  alt: string;
  title: string | null;
  width: number | null;
  height: number | null;
  align: ImageAlignment | null;
};

export const MAX_IMAGE_DIMENSION = 4096;
export const IMAGE_ALIGNMENT_STYLES: Record<ImageAlignment, string> = {
  left: 'display:block;max-width:100%;height:auto;margin-left:0;margin-right:auto',
  center: 'display:block;max-width:100%;height:auto;margin-left:auto;margin-right:auto',
  right: 'display:block;max-width:100%;height:auto;margin-left:auto;margin-right:0',
};

export function imageDimension(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^\d+$/u.test(String(value))) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= MAX_IMAGE_DIMENSION ? number : null;
}

export function imageAlignment(value: unknown): ImageAlignment | null {
  return value === 'left' || value === 'center' || value === 'right' ? value : null;
}

export function imageAlignmentFromStyle(value: unknown): ImageAlignment | null {
  return (Object.keys(IMAGE_ALIGNMENT_STYLES) as ImageAlignment[])
    .find((align) => IMAGE_ALIGNMENT_STYLES[align] === value) ?? null;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');
}

// A deliberately small HTML subset, shared by codec, reader and image discovery.
// No DOM parser, arbitrary CSS, event handlers or new URL permissions are involved.
export function parsePortableImage(source: string): PortableImage | null {
  const tag = /^<img((?:\s+[a-z]+="[^"<>]*")+)\s*\/?\s*>$/u.exec(source.trim());
  if (!tag) return null;
  const attrs: Record<string, string> = {};
  for (const match of tag[1].matchAll(/\s+([a-z]+)="([^"<>]*)"/gu)) {
    const key = match[1];
    if (!['src', 'alt', 'title', 'width', 'height', 'style'].includes(key) || key in attrs) return null;
    attrs[key] = proseEntities(match[2]);
  }
  if (!attrs.src || !('alt' in attrs)) return null;
  const width = imageDimension(attrs.width);
  const height = imageDimension(attrs.height);
  const align = imageAlignmentFromStyle(attrs.style);
  if (('width' in attrs && width === null) || ('height' in attrs && height === null)
    || ('style' in attrs && align === null)) return null;
  return { src: attrs.src, alt: attrs.alt, title: attrs.title ?? null, width, height, align };
}

export function serializePortableImage(image: PortableImage): string {
  return '<img src="' + escapeAttribute(image.src) + '" alt="' + escapeAttribute(image.alt) + '"'
    + (image.title !== null ? ' title="' + escapeAttribute(image.title) + '"' : '')
    + (image.width !== null ? ' width="' + image.width + '"' : '')
    + (image.height !== null ? ' height="' + image.height + '"' : '')
    + (image.align ? ' style="' + IMAGE_ALIGNMENT_STYLES[image.align] + '"' : '') + '>';
}

export function portableImageStyle(image: Pick<PortableImage, 'width' | 'height' | 'align'>) {
  return {
    display: 'block', maxWidth: '100%', width: image.width ?? 'fit-content', height: 'auto',
    marginLeft: image.align === 'center' || image.align === 'right' ? 'auto' : 0,
    marginRight: image.align === 'center' || image.align === 'left' ? 'auto' : 0,
  } as const;
}
