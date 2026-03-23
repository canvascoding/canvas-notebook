import { NextRequest, NextResponse } from 'next/server';
import { readFile } from '@/app/lib/filesystem/workspace-files';
import { auth } from '@/app/lib/auth';
import { marked } from 'marked';
import path from 'path';

const READ_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');

    if (!filePath) {
      return NextResponse.json(
        { success: false, error: 'Path parameter is required' },
        { status: 400 }
      );
    }

    // Verify it's a markdown file
    const ext = path.extname(filePath).toLowerCase();
    if (!['.md', '.mdx', '.markdown'].includes(ext)) {
      return NextResponse.json(
        { success: false, error: 'File must be a markdown file (.md, .mdx, .markdown)' },
        { status: 400 }
      );
    }

    // Read the file content
    const contentBuffer = await readFile(filePath);
    
    if (contentBuffer.length > READ_SIZE_LIMIT) {
      return NextResponse.json(
        { success: false, error: 'File is too large to export' },
        { status: 413 }
      );
    }

    const markdownContent = contentBuffer.toString('utf-8');

    // Configure marked with GFM support
    marked.use({
      gfm: true,
      breaks: true,
    });

    // Convert markdown to HTML
    let htmlContent = await marked.parse(markdownContent);

    // Get the directory of the markdown file for relative path resolution
    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath, ext);

    // Rewrite relative image paths to absolute /media/ URLs
    // Matches: ![alt](./image.png) or ![alt](image.png) or ![alt](../image.png)
    htmlContent = htmlContent.replace(
      /<img([^>]*)src="([^"]+)"([^>]*)>/g,
      (match, before, src, after) => {
        // Skip if already absolute URL
        if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/media/')) {
          return match;
        }
        
        // Resolve relative path to absolute workspace path
        let resolvedPath: string;
        if (src.startsWith('/')) {
          // Absolute path from workspace root
          resolvedPath = src.slice(1);
        } else if (src.startsWith('./') || src.startsWith('../')) {
          // Relative path
          resolvedPath = path.join(fileDir, src);
        } else {
          // Simple relative path
          resolvedPath = path.join(fileDir, src);
        }
        
        // Normalize path (resolve .. and .)
        resolvedPath = path.normalize(resolvedPath).replace(/\\/g, '/');
        
        return `<img${before}src="/media/${resolvedPath}"${after}>`;
      }
    );

    // Generate complete HTML document with print-optimized CSS
    const htmlDocument = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${fileName}</title>
  <style>
    /* Print-CSS: A4, 25mm Ränder, saubere Typographie */
    @page {
      size: A4;
      margin: 25mm 20mm;
    }
    
    * {
      box-sizing: border-box;
    }
    
    body {
      font-family: Georgia, serif;
      font-size: 11pt;
      line-height: 1.6;
      color: #222;
      max-width: 100%;
      margin: 0;
      padding: 0;
    }
    
    h1, h2, h3, h4, h5, h6 {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin-top: 1.5em;
      margin-bottom: 0.5em;
      line-height: 1.3;
    }
    
    h1 { font-size: 2em; border-bottom: 2px solid #333; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #ccc; padding-bottom: 0.3em; }
    h3 { font-size: 1.25em; }
    h4 { font-size: 1.1em; }
    
    p {
      margin: 0.8em 0;
    }
    
    pre {
      background: #f5f5f5;
      padding: 1em;
      border-radius: 4px;
      overflow: auto;
      border: 1px solid #e0e0e0;
      margin: 1em 0;
    }
    
    code {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
      font-size: 0.9em;
    }
    
    pre code {
      font-size: 0.85em;
      background: transparent;
      padding: 0;
    }
    
    /* Inline code */
    :not(pre) > code {
      background: #f0f0f0;
      padding: 0.2em 0.4em;
      border-radius: 3px;
    }
    
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
    }
    
    th, td {
      border: 1px solid #ccc;
      padding: 6px 10px;
      text-align: left;
    }
    
    th {
      background: #f5f5f5;
      font-weight: 600;
    }
    
    tr:nth-child(even) {
      background: #fafafa;
    }
    
    img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 1em auto;
    }
    
    blockquote {
      border-left: 4px solid #ddd;
      margin: 1em 0;
      padding-left: 1em;
      color: #555;
      font-style: italic;
    }
    
    ul, ol {
      margin: 0.8em 0;
      padding-left: 2em;
    }
    
    li {
      margin: 0.3em 0;
    }
    
    a {
      color: #0066cc;
      text-decoration: none;
    }
    
    a:hover {
      text-decoration: underline;
    }
    
    hr {
      border: none;
      border-top: 1px solid #ccc;
      margin: 2em 0;
    }
    
    /* Print optimizations */
    @media print {
      pre {
        white-space: pre-wrap;
        word-wrap: break-word;
      }
      
      a {
        text-decoration: underline;
      }
      
      a[href]:after {
        content: " (" attr(href) ")";
        font-size: 0.85em;
        color: #666;
      }
      
      /* Don't show URLs for internal links */
      a[href^="#"]:after,
      a[href^="/media/"]:after {
        content: "";
      }
    }
    
    /* Syntax highlighting colors */
    .hljs-comment,
    .hljs-quote {
      color: #998;
      font-style: italic;
    }
    
    .hljs-keyword,
    .hljs-selector-tag,
    .hljs-subst {
      color: #333;
      font-weight: bold;
    }
    
    .hljs-number,
    .hljs-literal,
    .hljs-variable,
    .hljs-template-variable,
    .hljs-tag .hljs-attr {
      color: #008080;
    }
    
    .hljs-string,
    .hljs-doctag {
      color: #d14;
    }
    
    .hljs-title,
    .hljs-section,
    .hljs-selector-id {
      color: #900;
      font-weight: bold;
    }
    
    .hljs-subst {
      font-weight: normal;
    }
    
    .hljs-type,
    .hljs-class .hljs-title {
      color: #458;
      font-weight: bold;
    }
    
    .hljs-tag,
    .hljs-name,
    .hljs-attribute {
      color: #000080;
      font-weight: normal;
    }
    
    .hljs-regexp,
    .hljs-link {
      color: #009926;
    }
    
    .hljs-symbol,
    .hljs-bullet {
      color: #990073;
    }
    
    .hljs-built_in,
    .hljs-builtin-name {
      color: #0086b3;
    }
    
    .hljs-meta {
      color: #999;
      font-weight: bold;
    }
    
    .hljs-deletion {
      background: #fdd;
    }
    
    .hljs-addition {
      background: #dfd;
    }
    
    .hljs-emphasis {
      font-style: italic;
    }
    
    .hljs-strong {
      font-weight: bold;
    }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;

    // Return the HTML document
    return new NextResponse(htmlDocument, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-cache',
      },
    });
  } catch (error) {
    console.error('[API] Markdown export error:', error);
    
    // If the error is ENOENT (file not found), return a 404 status
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      );
    }
    
    const message = error instanceof Error ? error.message : 'Failed to export markdown file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
