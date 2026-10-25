/** The managed browser may use a different loopback port inside its container. */
export function createBrowserFixtureUrl(input: {
  access: string; baseUrl: string; fixturePort?: string; promptOnLoad?: boolean;
}): string {
  const base = new URL(input.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
    || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    throw new Error('Browser fixture base URL must be a plain loopback HTTP(S) origin.');
  }
  const url = new URL('/api/browser/view/fixture-page', base.origin);
  url.hostname = 'localhost';
  if (input.fixturePort !== undefined) {
    if (!/^[1-9]\d*$/u.test(input.fixturePort) || Number(input.fixturePort) > 65_535) {
      throw new Error('TEST_BROWSER_FIXTURE_PORT must be an integer between 1 and 65535.');
    }
    url.port = input.fixturePort;
  }
  url.searchParams.set('access', input.access);
  if (input.promptOnLoad) url.searchParams.set('promptOnLoad', '1');
  return url.toString();
}
