import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import type { NextConfig } from 'next';
import { tryToParsePath } from 'next/dist/lib/try-to-parse-path';

async function main() {
  const filename = path.resolve('next.config.ts'), native = createRequire(filename), compiled = { exports: {} as { default?: NextConfig } };
  const code = ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const mocks: Record<string, unknown> = { '@sentry/nextjs': { withSentryConfig: (config: NextConfig) => config },
    'next-intl/plugin': () => (config: NextConfig) => config };
  new Function('require','module','exports',code)((name: string) => name in mocks ? mocks[name] : native(name), compiled, compiled.exports);
  const config = compiled.exports.default!; assert.ok(config.headers);
  const routes = await config.headers!();
  const effective = (pathname: string) => {
    const headers = new Map<string,string>();
    for (const route of routes) {
      const parsed = tryToParsePath(route.source); assert.equal(parsed.error,undefined); assert.ok(parsed.regexStr);
      if (new RegExp(parsed.regexStr!).test(pathname)) for (const header of route.headers) headers.set(header.key.toLowerCase(),header.value);
    }
    return headers;
  };
  const ticket = 'a'.repeat(43);
  for (const mode of ['host','frame','document']) {
    const headers = effective(`/__preview/${ticket}/mobile-mcp/${mode}`);
    assert.equal(headers.get('referrer-policy'),'no-referrer');
    assert.equal(headers.get('x-frame-options'), mode === 'host' ? 'DENY' : '');
    assert.equal(headers.has('content-security-policy'),false,'Dedicated route CSP is preserved.');
  }
  for (const pathname of ['/', '/api/mobile/v1/sessions/chat/mcp-apps/render', `/__preview/${ticket}/mcp-app/frame`,
    `/__preview/${ticket}/mobile-mcp/host/extra`, `/__preview/${ticket.slice(1)}/mobile-mcp/host`]) {
    assert.equal(effective(pathname).get('referrer-policy'),'strict-origin-when-cross-origin','Ordinary web/header behavior is unchanged.');
    assert.equal(effective(pathname).get('x-frame-options'),'SAMEORIGIN');
  }
  const artifact='./public/_canvas-tool-apps/mobile-mcp-host-v1.js';
  assert.deepEqual(config.outputFileTracingIncludes?.['/api/mobile/v1/sessions/*/mcp-apps/render'],[artifact]);
  assert.deepEqual(config.outputFileTracingIncludes?.['/__preview/*/mobile-mcp/*'],[artifact]);
  assert.ok((await fs.stat(path.resolve(artifact))).size > 0);
  console.log('Mobile MCP Next configuration: exact ordered no-referrer/frame overrides, unchanged web headers and targeted host artifact tracing passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
