const HEX_COLOR_PATTERN = '#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})';
const INLINE_HEX_COLOR_PATTERN = '#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})\\b';
const RGB_COLOR_PATTERN = 'rgb\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*\\)';
const RGBA_COLOR_PATTERN = 'rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*[\\d.]+\\s*\\)';
const HSL_COLOR_PATTERN = 'hsl\\(\\s*\\d+\\s*,\\s*\\d+%?\\s*,\\s*\\d+%?\\s*\\)';
const HSLA_COLOR_PATTERN = 'hsla\\(\\s*\\d+\\s*,\\s*\\d+%?\\s*,\\s*\\d+%?\\s*,\\s*[\\d.]+\\s*\\)';

export const COLOR_REGEX = new RegExp(
  `(${HEX_COLOR_PATTERN}|${RGB_COLOR_PATTERN}|${RGBA_COLOR_PATTERN}|${HSL_COLOR_PATTERN}|${HSLA_COLOR_PATTERN})`,
  'i',
);

export const INLINE_HEX_REGEX = new RegExp(INLINE_HEX_COLOR_PATTERN, 'g');
export const INLINE_RGB_REGEX = new RegExp(`${RGBA_COLOR_PATTERN}|${RGB_COLOR_PATTERN}`, 'gi');
export const INLINE_COLOR_REGEX = new RegExp(
  `${INLINE_HEX_COLOR_PATTERN}|${RGBA_COLOR_PATTERN}|${RGB_COLOR_PATTERN}`,
  'gi',
);

const HEX_REGEX = new RegExp(`^${HEX_COLOR_PATTERN}$`);
const RGB_REGEX = new RegExp(`^${RGB_COLOR_PATTERN}$`, 'i');
const RGBA_REGEX = new RegExp(`^${RGBA_COLOR_PATTERN}$`, 'i');
const HSL_REGEX = new RegExp(`^${HSL_COLOR_PATTERN}$`, 'i');
const HSLA_REGEX = new RegExp(`^${HSLA_COLOR_PATTERN}$`, 'i');

export function isColorCode(str: string): boolean {
  const trimmed = str.trim();
  return HEX_REGEX.test(trimmed)
    || RGB_REGEX.test(trimmed)
    || RGBA_REGEX.test(trimmed)
    || HSL_REGEX.test(trimmed)
    || HSLA_REGEX.test(trimmed);
}

export function createInlineColorRegex() {
  return new RegExp(INLINE_COLOR_REGEX.source, INLINE_COLOR_REGEX.flags);
}
