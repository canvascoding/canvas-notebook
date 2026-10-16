import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CAPABILITY_PACKAGE_ICON_MAX_BYTES, supportedImage } from '../app/lib/capabilities/packages/package-icon-image';
import { validateCreatorPluginSvg } from '../app/lib/capabilities/packages/creator-plugin-svg';

const file = './assets/logo.svg';
const body = '<title id="title">Account brief</title><desc id="description">CRM rows and research become one account brief.</desc><rect width="64" height="64" fill="#123456"/>';
const document = (content = body, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" ${extra}>${content}</svg>`;

function rejected(value: string | Buffer, code: string, label: string, sourceFile = file): void {
  const issues = validateCreatorPluginSvg(Buffer.isBuffer(value) ? value : Buffer.from(value), sourceFile);
  assert(issues.some(issue => issue.code === code), `${label}: expected ${code}, got ${JSON.stringify(issues)}`);
  for (const issue of issues) {
    assert.equal(issue.file, sourceFile);
    assert.equal(issue.field, 'interface.logo');
    assert(issue.message.length > 0 && issue.repair.length > 0, `${label}: actionable structured issue`);
  }
}

async function main(): Promise<void> {
  const examples = [
    document(),
    `<?xml version="1.0" encoding="UTF-8"?><!-- purpose graphic -->${document()}`,
    document(body.replace('Account brief', 'Account &amp; brief').replace('CRM rows', '<![CDATA[CRM rows]]>')),
    document('<title>Local gradient</title><desc>A static card filled with its local gradient.</desc><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#123"/></linearGradient><path id="shape" d="M0 0h32v32z"/></defs><use href="#shape" fill="url(#paint)"/>'),
    document('<title>Local clipping</title><desc>A clipped card uses one local shape.</desc><defs><clipPath id="clip"><circle r="32"/></clipPath></defs><g clip-path="url(\'\x23clip\')"><rect width="64" height="64"/></g>'),
    document('<title>Namespaced references</title><desc>A local shape remains self contained.</desc><defs><path id="shape" d="M0 0h32v32z"/></defs><use local:href="#shape"/>', 'xmlns:local="http://www.w3.org/1999/xlink"'),
    document(body, 'role="img" aria-labelledby="title description"').replace('viewBox="0 0 64 64"', 'viewBox="-1.5,+2,6.4e1,64"'),
    document(body.replace('fill="#123456"', 'fill="u&#114;l(#paint)"') + '<defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient></defs>'),
  ];
  for (const [index, xml] of examples.entries()) {
    assert.deepEqual(validateCreatorPluginSvg(Buffer.from(xml), file), [], `actual positive SVG ${index}`);
    assert(supportedImage(Buffer.from(xml), 'image/svg+xml'), 'Every accepted creator image can be served by the existing image reader');
  }
  const ownGraphic = await fs.readFile(path.join(process.cwd(), 'seed_plugins/plugin-creator/skills/plugin-visual/assets/logo.svg'));
  assert.deepEqual(validateCreatorPluginSvg(ownGraphic, file), [], 'The shipped purpose-image example satisfies the byte validator');

  const malformed = [
    '', '<svg', document().replace('</rect>', ''), document().replace('/></svg>', '></svg>'),
    document().replace('width="64"', 'width=64'), document() + '<svg/>', document() + 'trailing text',
    document().replace('CRM rows', '&unknown;'), document().replace('CRM rows', '\u0000'),
    document().replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 64" viewBox="0 0 64 64"'),
  ];
  for (const [index, xml] of malformed.entries()) {
    if (!xml) rejected(xml, 'CREATOR_SVG_SIZE_INVALID', `empty SVG ${index}`);
    else if (xml !== document()) rejected(xml, 'CREATOR_SVG_XML_INVALID', `malformed SVG ${index}`);
  }
  rejected(Buffer.from([0xc3, 0x28]), 'CREATOR_SVG_XML_INVALID', 'Invalid UTF-8');
  rejected(`<?xml version="1.0" encoding="ISO-8859-1"?>${document()}`, 'CREATOR_SVG_XML_INVALID', 'Encoding declaration cannot reinterpret captured bytes');
  for (const xml of [
    '<!DOCTYPE svg SYSTEM "https://private.example/source.dtd">' + document(),
    '<!DOCTYPE svg [<!ENTITY private SYSTEM "file:///private/source">]>' + document(body.replace('CRM rows', '&private;')),
    '<!DOCTYPE svg [<!ENTITY repeated "repeated">]>' + document(body.replace('CRM rows', '&repeated;')),
    '<?xml-stylesheet href="https://private.example/style.css"?>' + document(),
  ]) rejected(xml, 'CREATOR_SVG_PASSIVE_REQUIRED', 'DOCTYPE, external/internal entities and PI are rejected');
  for (const xml of [
    document().replace('xmlns="http://www.w3.org/2000/svg"', ''),
    document().replace('http://www.w3.org/2000/svg', 'https://www.w3.org/2000/svg'),
    document().replace('<svg ', '<html ').replace('</svg>', '</html>'),
    document().replace('<rect ', '<rect xmlns="http://www.w3.org/1999/xhtml" '),
    document(body, 'xmlns:foreign="https://private.example/ns"'),
  ]) rejected(xml, xml.includes('<rect xmlns=') ? 'CREATOR_SVG_PASSIVE_REQUIRED' : 'CREATOR_SVG_NAMESPACE_INVALID', 'Namespaces are resolved from actual XML');
  rejected(document(body, 'xmlns:f="https://private.example/ns" f:onload="run()"'), 'CREATOR_SVG_PASSIVE_REQUIRED', 'Foreign namespace attribute');
  for (const viewBox of ['', '0 0 0 64', '0 0 -1 64', '0 0 64', '0,,0,64,64', '0 0 Infinity 64', '0 0 NaN 64', '0 0 1e999 64', '1e308 0 1e308 64', '0 0 1e-999 64', '0 0 64px 64']) {
    rejected(document().replace('0 0 64 64', viewBox), 'CREATOR_SVG_VIEWBOX_INVALID', `Invalid viewBox ${viewBox}`);
  }
  rejected(document(body.replace('<title id="title">Account brief</title>', '')), 'CREATOR_SVG_TITLE_REQUIRED', 'Missing title');
  rejected(document(body.replace('Account brief', ' \t\n ')), 'CREATOR_SVG_TITLE_REQUIRED', 'Whitespace title');
  rejected(document(body.replace('CRM rows and research become one account brief.', '...')), 'CREATOR_SVG_DESCRIPTION_REQUIRED', 'Description needs meaningful text');
  rejected(document(body.replace('<desc id="description">CRM rows and research become one account brief.</desc>', '')), 'CREATOR_SVG_DESCRIPTION_REQUIRED', 'Missing description');
  rejected(document(`<g>${body}</g>`), 'CREATOR_SVG_TITLE_REQUIRED', 'Nested metadata cannot replace root metadata');
  rejected(document('<title><tspan>Brief</tspan></title><desc>A brief.</desc>'), 'CREATOR_SVG_METADATA_INVALID', 'Metadata must be plain text');
  rejected(document(body + '<title>Second title</title>'), 'CREATOR_SVG_TITLE_REQUIRED', 'Ambiguous duplicated root title');

  for (const extra of [
    '<script>run()</script>', '<style>rect { fill: red; }</style>', '<foreignObject><div>Text</div></foreignObject>',
    '<a href="#title"><rect width="1" height="1"/></a>', '<animate attributeName="x" from="0" to="9"/>',
    '<set attributeName="href" to="https://private.example/image"/>', '<image href="data:image/png;base64,eA=="/>',
    '<image href="https://private.example/image"/>', '<feImage href="file:///private/image"/>',
  ]) rejected(document(body + extra), 'CREATOR_SVG_PASSIVE_REQUIRED', 'Active elements and embedded resources');
  for (const attribute of [
    'onload="run()"', 'ONLOAD="run()"', 'style="fill: red"', 'style="fill:u\\72l(https://private.example/image)"',
    'fill="url(https://private.example/image)"', 'fill="u&#114;l(https://private.example/image)"',
    'fill="u\\72l(https://private.example/image)"', 'fill="url(/*hidden*/#title)"',
    'font-family="@import remote"', 'href="data:image/svg+xml;base64,eA=="', 'href="https://private.example/image"',
    'href="file:///private/image"', 'href="java&#115;cript:run()"', 'xml:base="https://private.example/"',
  ]) rejected(document(body, attribute), 'CREATOR_SVG_PASSIVE_REQUIRED', `Decoded unsafe attribute ${attribute}`);
  rejected(document(body, 'xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://private.example/image"'), 'CREATOR_SVG_PASSIVE_REQUIRED', 'Aliased XLink external reference');
  rejected(document(body, 'href="#missing"'), 'CREATOR_SVG_REFERENCE_INVALID', 'Missing local reference');
  rejected(document(body + '<path id="title" d="M0 0h2"/>'), 'CREATOR_SVG_REFERENCE_INVALID', 'Duplicate local ID');

  for (const sourceFile of ['/assets/logo.svg', '../logo.svg', 'assets/../logo.svg', 'assets//logo.svg', 'assets\\logo.svg', 'https://private.example/logo.svg', 'assets/logo.png', '././assets/logo.svg']) {
    rejected(document(), 'CREATOR_SVG_PATH_INVALID', 'Invalid purpose-image path', sourceFile);
  }
  const budgeted = Buffer.from(document('<!--' + ' '.repeat(CAPABILITY_PACKAGE_ICON_MAX_BYTES - Buffer.byteLength(document('<!---->' + body))) + '-->' + body));
  assert.equal(budgeted.length, CAPABILITY_PACKAGE_ICON_MAX_BYTES);
  assert.deepEqual(validateCreatorPluginSvg(budgeted, file), [], 'Exactly 2 MiB remains valid');
  rejected(Buffer.concat([budgeted, Buffer.from(' ')]), 'CREATOR_SVG_SIZE_INVALID', 'More than 2 MiB is rejected before parsing');
  rejected(document('<g>'.repeat(128) + body + '</g>'.repeat(128)), 'CREATOR_SVG_COMPLEXITY_LIMIT', 'Bounded XML depth');
  rejected(document(body + '<path/>'.repeat(10_000)), 'CREATOR_SVG_COMPLEXITY_LIMIT', 'Bounded XML node count');

  const changed = Buffer.from(document());
  assert.deepEqual(validateCreatorPluginSvg(changed, file), []);
  changed.write('<script>', changed.indexOf('<rect'));
  assert(validateCreatorPluginSvg(changed, file).length > 0, 'Revalidating changed bytes cannot reuse an earlier successful result');
  assert.deepEqual(validateCreatorPluginSvg(Buffer.from(document()), 'assets/logo.svg'), [], 'Canonical path without ./ is also valid');
  console.log('PASS Creator SVG actual-byte validator: XML/namespaces/metadata/viewBox, passive local resources, decoded unsafe values, XXE/PI, malformed/trailing input, 2 MiB/depth/node budgets and changed-byte revalidation.');
}

main().catch(error => {console.error(error);process.exitCode = 1;});
