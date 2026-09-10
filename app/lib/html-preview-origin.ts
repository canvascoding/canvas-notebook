type PreviewEnvironment = Record<string, string | undefined>;

function origin(value: string): URL {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.hostname.endsWith('.')) {
    throw new Error('HTML preview requires an HTTP(S) origin without a path or credentials');
  }
  return parsed;
}

/** Uses the configured deployment origin only, never a request Host/forwarded header. */
export function canvasAppOrigin(env: PreviewEnvironment = process.env): string {
  return origin(env.BETTER_AUTH_BASE_URL || env.BASE_URL || `http://localhost:${env.PORT || '3000'}`).origin;
}

/** Uses configured deployment origins only, never a request Host/forwarded header. */
export function htmlPreviewOrigins(env: PreviewEnvironment = process.env) {
  const app = origin(env.BETTER_AUTH_BASE_URL || env.BASE_URL || `http://localhost:${env.PORT || '3000'}`);
  const local = app.hostname === 'localhost' || app.hostname.endsWith('.localhost')
    || app.hostname === '127.0.0.1' || app.hostname === '[::1]';
  let preview: URL;
  if (env.CANVAS_HTML_PREVIEW_ORIGIN?.trim()) preview = origin(env.CANVAS_HTML_PREVIEW_ORIGIN.trim());
  else if (local) preview = origin(`${app.protocol}//preview.localhost${app.port ? ':' + app.port : ''}`);
  else {
    if (/^[\d.]+$/u.test(app.hostname) || app.hostname.includes(':')) {
      throw new Error('CANVAS_HTML_PREVIEW_ORIGIN is required for deployments addressed by IP');
    }
    preview = origin(`${app.protocol}//preview.${app.host}`);
  }
  if (preview.hostname === app.hostname || (app.protocol === 'https:' && preview.protocol !== 'https:')) {
    throw new Error('HTML preview requires a different hostname and HTTPS when the app uses HTTPS');
  }
  return {appOrigin:app.origin, previewOrigin:preview.origin};
}

export function isHtmlPreviewHost(host: string | null | undefined, env: PreviewEnvironment = process.env) {
  if (!host || /[\s/@\\?#]/u.test(host)) return false;
  try {
    const preview = new URL(htmlPreviewOrigins(env).previewOrigin);
    return new URL(`${preview.protocol}//${host}`).host === preview.host;
  } catch { return false; }
}

export function htmlPreviewUrl(urlPath: string, env: PreviewEnvironment = process.env) {
  return new URL(urlPath, htmlPreviewOrigins(env).previewOrigin).href;
}

export function optionalHtmlPreviewOrigin(env: PreviewEnvironment = process.env): string | null {
  try { return htmlPreviewOrigins(env).previewOrigin; } catch { return null; }
}
