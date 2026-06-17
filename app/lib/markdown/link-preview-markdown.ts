export const LINK_PREVIEW_IMAGE_ALT_PREFIX = 'Link preview:';

export function makeLinkPreviewImageAlt(label: string) {
  const normalizedLabel = label.replace(/\s+/gu, ' ').trim();
  return `${LINK_PREVIEW_IMAGE_ALT_PREFIX} ${normalizedLabel || 'link'}`;
}

export function parseLinkPreviewImageAlt(value: string | undefined) {
  const alt = value?.trim() || '';
  if (!alt.toLowerCase().startsWith(LINK_PREVIEW_IMAGE_ALT_PREFIX.toLowerCase())) return null;
  return alt.slice(LINK_PREVIEW_IMAGE_ALT_PREFIX.length).trim() || 'link';
}
