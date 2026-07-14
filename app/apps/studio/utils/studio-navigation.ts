export type StudioBackDestination =
  | { href: '/'; label: 'suite' }
  | { href: '/studio/models'; label: 'models' }
  | { href: '/studio/presets'; label: 'presets' };

export function getStudioBackDestination(pathname: string | null): StudioBackDestination {
  if (
    pathname?.match(/^\/studio\/models\/[^/]+$/)
    || pathname?.match(/^\/studio\/(?:products|personas)\/[^/]+$/)
  ) {
    return { href: '/studio/models', label: 'models' };
  }

  if (pathname?.match(/^\/studio\/presets\/[^/]+$/)) {
    return { href: '/studio/presets', label: 'presets' };
  }

  return { href: '/', label: 'suite' };
}
