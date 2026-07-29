export function getPathWithoutLicenseKey(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has('key')) return null;
  url.searchParams.delete('key');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function scrubLicenseKeyFromBrowserUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const nextPath = getPathWithoutLicenseKey(window.location.href);
  if (!nextPath) return false;
  window.history.replaceState(window.history.state, '', nextPath);
  return true;
}
