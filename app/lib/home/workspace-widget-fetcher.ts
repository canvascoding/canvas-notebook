type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function internalAppOrigin(port = process.env.PORT): string {
  return `http://127.0.0.1:${port || '3000'}`;
}

export function createWorkspaceWidgetFetcher(
  requestHeaders: Headers,
  fetcher: Fetcher = fetch,
  origin = internalAppOrigin(),
): Fetcher {
  return (input, init) => {
    const value = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const cookie = requestHeaders.get('cookie');
    if (cookie) headers.set('cookie', cookie);
    return fetcher(new URL(value, origin), { ...init, headers });
  };
}
