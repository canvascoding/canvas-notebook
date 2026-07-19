import { randomBytes } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { verifyBrowserFixtureTicket } from '@/app/lib/pi/browser/view-fixture-ticket';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function fixtureHtml(access: string, nonce: string): string {
  const downloadHref = `/api/browser/view/fixture-download?access=${encodeURIComponent(access)}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Browser transfer fixture</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7f9; color: #18242e; }
    main { width: min(680px, calc(100vw - 48px)); border: 1px solid #9cadb9; background: #fff; padding: 32px; box-sizing: border-box; box-shadow: 0 12px 36px rgb(22 45 61 / 10%); }
    small { color: #17557a; font: 700 11px ui-monospace, monospace; letter-spacing: .18em; text-transform: uppercase; }
    h1 { margin: 12px 0 8px; font-size: 30px; }
    p { margin: 0; color: #5b6b76; line-height: 1.55; }
    section { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 32px; }
    label, a { min-height: 132px; border: 1px solid #9cadb9; padding: 18px; box-sizing: border-box; color: inherit; text-decoration: none; }
    label:focus-within, a:focus { outline: 3px solid #72b8df; outline-offset: 2px; }
    strong, span { display: block; }
    span { margin-top: 8px; color: #5b6b76; font-size: 12px; }
    input { margin-top: 24px; max-width: 100%; }
    @media (max-width: 560px) { section { grid-template-columns: 1fr; } main { padding: 24px; } }
  </style>
</head>
<body>
  <main>
    <small>Browser Lab diagnostic</small>
    <h1>Secure file transfer</h1>
    <p>This ticket-protected page verifies workspace-mediated uploads and controlled browser downloads.</p>
    <section>
      <label>
        <strong>Upload from workspace</strong>
        <span id="selection">No file selected</span>
        <input id="upload" type="file">
      </label>
      <a id="download" href="${downloadHref}">
        <strong>Download into workspace</strong>
        <span>browser-lab-download.txt</span>
      </a>
    </section>
  </main>
  <script nonce="${nonce}">
    document.getElementById('upload').addEventListener('change', function (event) {
      const name = event.target.files && event.target.files[0] ? event.target.files[0].name : 'No file selected';
      document.getElementById('selection').textContent = name;
      document.title = name === 'No file selected' ? 'Browser transfer fixture' : 'Uploaded: ' + name;
      document.getElementById('download').focus();
    });
  </script>
</body>
</html>`;
}

export async function GET(request: NextRequest) {
  const access = request.nextUrl.searchParams.get('access') || '';
  try {
    verifyBrowserFixtureTicket(access);
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'browser-view-fixture-page',
  });
  if (!limited.ok) return limited.response;

  const nonce = randomBytes(18).toString('base64');
  return new NextResponse(fixtureHtml(access, nonce), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
