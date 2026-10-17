import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CAPABILITY_PACKAGE_ICON_MAX_BYTES, supportedImage } from '../app/lib/capabilities/packages/package-icon-image';

const workerArgument = '--svg-prefix-worker';
const timeoutMs = 5_000;
if (process.argv.includes(workerArgument)) {
  const image = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';
  for (const prefix of ['', '\uFEFF \n\t', '<!-- one --><!-- two -->\n',
    '<?xml version="1.0"?>\n<!-- image -->\n', '<?XML version="1.0"?>\n']) {
    assert.equal(supportedImage(Buffer.from(prefix + image), 'image/svg+xml'), true,
      'A valid optional XML declaration and comment prefix remains accepted');
  }
  assert.equal(supportedImage(Buffer.from('<!-- image --><svg />'), 'image/svg+xml'), true);
  for (const value of ['<?xml version="1.0"?><!----><SVG width="1" />\n', '<svg></svg \n > \n',
    '<svg><defs><path id="shape"/></defs><use xlink:href="#shape"/></svg>',
    '<svg><image href="#shape" src=\'#shape\'/></svg>',
    '<svg><style>path {fill:url("#shape");stroke:url(\'#shape\')}</style></svg>']) {
    assert.equal(supportedImage(Buffer.from(value), 'image/svg+xml'), true, 'Valid root endings and internal fragments remain accepted');
  }
  for (const value of ['<svg><image href="https://external.example/image"/></svg>',
    '<svg><image xlink:href="https://external.example/image"/></svg>', '<svg><image src="//external.example/image"/></svg>',
    '<svg><image href=#shape /></svg>', '<svg><image href="unterminated /></svg>',
    '<svg><style>path{fill:url(https://external.example/image)}</style></svg>',
    '<svg><style>path{fill:url(#shape}</style></svg>', '<svg><style>path{fill:url(#shape url(#other))}</style></svg>']) {
    assert.equal(supportedImage(Buffer.from(value), 'image/svg+xml'), false, 'External or malformed attribute/CSS URLs are rejected');
  }
  assert.equal(supportedImage(Buffer.from(image + ' trailing'), 'image/svg+xml'), false, 'Closing rules remain enforced');
  for (const value of ['<?xml version="1.0"?broken><svg/>', '<?xml?><!----><?xml?><svg/>', '<!-- unterminated',
    '<!---->not-svg', '<!----><?xml?><svg/>', '\uFFFD' + image]) {
    assert.equal(supportedImage(Buffer.from(value), 'image/svg+xml'), false, 'Malformed prefixes are rejected');
  }
  for (const limit of [256 * 1024, CAPABILITY_PACKAGE_ICON_MAX_BYTES]) {
    const malformed = '<!--' + '--><!--'.repeat(Math.floor((limit - 7) / 7)) + '<x>';
    assert(Buffer.byteLength(malformed) <= limit);
    assert.equal(supportedImage(Buffer.from(malformed), 'image/svg+xml'), false,
      'Ambiguous comment terminators cannot cause regex backtracking at either image limit');
    const prefix = '<!-- image -->\n'.repeat(Math.floor((limit - Buffer.byteLength(image)) / 15));
    assert(Buffer.byteLength(prefix + image) <= limit);
    assert.equal(supportedImage(Buffer.from(prefix + image), 'image/svg+xml'), true,
      'Many valid leading comments remain accepted within the same byte limits');
    for (const suffix of ['x', 'x>', ' />']) {
      const unterminated = '<svg '.repeat(Math.floor((limit - Buffer.byteLength(suffix)) / 5)) + suffix;
      assert(Buffer.byteLength(unterminated) <= limit);
      assert.equal(supportedImage(Buffer.from(unterminated), 'image/svg+xml'), false,
        'Repeated unterminated root tags are rejected without retrying every SVG prefix');
    }
    const cssStart = '<svg><style>', cssEnd = '</style></svg>';
    const malformedCss = cssStart + 'url('.repeat(Math.floor((limit - cssStart.length - cssEnd.length) / 4)) + cssEnd;
    assert(Buffer.byteLength(malformedCss) <= limit);
    assert.equal(supportedImage(Buffer.from(malformedCss), 'image/svg+xml'), false,
      'An unterminated CSS URL is rejected once at either byte limit');
    const longText = '<svg>' + 'a-'.repeat(Math.floor((limit - 11) / 2)) + '</svg>';
    assert(Buffer.byteLength(longText) <= limit);
    assert.equal(supportedImage(Buffer.from(longText), 'image/svg+xml'), true,
      'Long valid text does not retry the optional attribute namespace from every word boundary');
  }
  // A tiny payload already times out with the old nested regex, independently
  // of either byte limit. Run all stress cases outside the main test process.
  assert.equal(supportedImage(Buffer.from('<!--' + '--><!--'.repeat(32) + '<x>'), 'image/svg+xml'), false);
  process.stdout.write('PASS isolated SVG validation worker\n');
} else {
  const result = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx',
    path.resolve('scripts/capability-package-icon-prefix-test.ts'), workerArgument],
  {encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024});
  assert.ifError(result.error);
  assert.equal(result.signal, null, `SVG validation must complete within ${timeoutMs}ms`);
  assert.equal(result.status, 0, result.stderr || 'The isolated SVG validation worker failed');
  assert.equal(result.stdout, 'PASS isolated SVG validation worker\n');
  console.log('PASS actual passive-image helper: XML/comments/root-ending/internal-fragment compatibility and bounded-process prefix/root/CSS/namespace ReDoS regressions at MCP/package byte limits.');
}
