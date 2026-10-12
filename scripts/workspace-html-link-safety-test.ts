import assert from 'node:assert/strict';

import { evaluateWorkspaceHtmlLinks, hasUnevaluatedWorkspaceHtmlLinks } from '../app/lib/markdown/workspace-html-link-safety';
import { parseWorkspaceLocalLinks } from '../app/lib/markdown/workspace-local-link-parser';
import { createWorkspaceFileOperationPlan } from '../app/lib/markdown/workspace-file-operation-planner';

const supported: Array<[string, string[]]> = [
  ['<img src="canvas-holdings-screenshot.png" alt="Canvas Holdings Screenshot" style="display:block;max-width:100%;height:auto;margin-left:auto;margin-right:auto">', ['canvas-holdings-screenshot.png']],
  ["<IMG SRC='../Bild%201.png#Ansicht' width='320'>", ['../Bild 1.png']],
  ['<a href=/Notes/Plan.md>Plan</a>', ['/Notes/Plan.md']],
  ['<a href="Notes/Plan%23Final.md#Section">Plan</a>', ['Notes/Plan#Final.md']],
  ['<img src="assets/a&amp;b.png">', ['assets/a&b.png']],
  ['<img src="assets/a&#65;b.png">', ['assets/aAb.png']],
  ['<img src="assets/a&#x41;b.png">', ['assets/aAb.png']],
  ['<img src="assets/a%252Fb.png">', ['assets/a%2Fb.png']],
  ['<a href="Notes/Plan.md"><img src="https://example.com/fixture.svg"></a>', ['Notes/Plan.md']],
  ['<div><a href="Notes/Plan.md">Plan</a><img src="assets/image.png"></div>', ['Notes/Plan.md', 'assets/image.png']],
  ['<img src="image.png" style="DISPLAY:inline-block; width:320px!important; margin:0 auto; padding:0 1rem">', ['image.png']],
  ['<figure class="media" aria-label="Image"><img src="image.png" alt="Image"><figcaption>Image</figcaption></figure>', ['image.png']],
];
for (const [html, targets] of supported) {
  assert.deepEqual(evaluateWorkspaceHtmlLinks(html), { unevaluated: true, explicitLocalTargets: targets }, html);
  assert.equal(hasUnevaluatedWorkspaceHtmlLinks(html), true, 'The legacy boolean continues to report local HTML');
}

const unsupported = [
  '<img src="image.png" srcset="image.png 1x, other.png 2x">',
  '<img src="image.png" imagesrcset="https://example.com/other.png 2x">',
  '<a href="Notes/Plan.md" ping="https://example.com/ping">Plan</a>',
  '<img src="image.png" style="background:url(other.png)">',
  '<img src="image.png" style="background:u\\72l(other.png)">',
  '<img src="image.png" style="@import other.css">',
  '<img src="image.png" style="background-image:image-set(\'moved.png\' 1x)">',
  '<img src="image.png" style="background-image:-webkit-image-set(\'moved.png\' 1x)">',
  '<img src="image.png" style="background-image:image(\'moved.png\')">',
  '<img src="image.png" style="background-image:cross-fade(image(\'moved.png\'),white)">',
  '<img src="image.png" style="src:local(\'moved.png\')">',
  '<img src="image.png" style="--asset:\'moved.png\'">',
  '<img src="image.png" style="width:var(--asset)">',
  '<img src="image.png" style="width:attr(data-resource)">',
  '<img src="image.png" style="width:calc(100% - 10px)">',
  '<img src="image.png" style="display:block;content:\'moved.png\'">',
  '<img src="image.png" style="background-image:inherit">',
  '<img src="image.png" style="dis\\70lay:block">',
  '<img src="image.png" style="width:100%;/*comment*/height:auto">',
  '<img src="image.png" onerror="this.src=\'other.png\'">',
  '<img src="image.png" src="other.png">',
  '<img src="image.png" SRC="other.png">',
  '<img src="image.png" alt="unterminated>',
  '<img src="">',
  '<img src="image.png?size=large">',
  '<img src="image%3Fsize.png">',
  '<img src="image%00.png">',
  '<img src="image%5Cname.png">',
  '<img src="image%ZZ.png">',
  '<img src="../">',
  '<img src=".">',
  '<img src="file:image.png">',
  '<img src="/notebook?path=image.png">',
  '<a href="https://canvasnotebook.app/notebook?path=Notes/Plan.md">Plan</a>',
  '<div src="image.png"></div>',
  '<video poster="image.png"></video>',
  '<img src="image.png"><video poster="other.png"></video>',
  '<img src="image.png" data-src="other.png">',
  '<img src="image.png"><base href="https://example.com/">',
  '<base href="../">',
  '<script src="https://example.com/script.js"></script>',
  '<style>img { background: url(image.png) }</style>',
  '<iframe src="https://example.com/"></iframe>',
  '<object data="image.png"></object>',
  '<embed src="image.png">',
  '<svg><a href="image.png">Image</a></svg>',
  '<img src="image.png"><template><img src="other.png"></template>',
  '<img src="stable.png"><meta http-equiv="refresh" content="0; url=moved.md">',
  '<meta http-equiv="refresh" content="0; url=moved.md">',
  '<img src="stable.png" attributionsrc="moved.md">',
  '<img attributionsrc="moved.md">',
  '<img src="stable.png" lowsrc="moved.md">',
  '<img src="stable.png" dynsrc="moved.md">',
  '<img src="stable.png"><custom-element resource="moved.md"></custom-element>',
  '<img src="stable.png" custom-resource="moved.md">',
  '<img src="stable.png" data-resource="moved.md">',
  '<img src="stable.png"><param name="movie" value="moved.md">',
  '<img src="a&sol;b.png" alt="Image">',
  '<img src="a&amp.png" alt="Image">',
  '<img src="a&#128;b.png" alt="Image">',
  '<img src="a&#0;b.png" alt="Image">',
  '<img src=" image.png " alt="Image">',
  '<img src="/api/media/preview/moved.png" alt="Image">',
  '<img src="/public/assets/moved.png" alt="Image">',
  '<img src="/_next/image/moved.png" alt="Image">',
  '<img src="%2Fimage.png" alt="Fixture">',
];
for (const html of unsupported) {
  assert.deepEqual(evaluateWorkspaceHtmlLinks(html), { unevaluated: true }, html);
}

for (const html of [
  '<img src="https://example.com/fixture.svg">',
  '<img src="//example.com/fixture.svg">',
  '<img src="data:image/png;base64,AA==">',
  '<a href="mailto:test@example.com">Email</a>',
  '<a href="#Section">Section</a>',
  '<div class="callout"><strong>Text</strong></div>',
  '<!-- <img src="image.png"> -->',
]) {
  assert.deepEqual(evaluateWorkspaceHtmlLinks(html), { unevaluated: false }, html);
  assert.equal(hasUnevaluatedWorkspaceHtmlLinks(html), false, html);
}

const html = '<div>\n<img src="assets/a%252Fb.png">\n<a href="Notes/Plan%23Final.md#Section">Plan</a>\n</div>';
const parsed = parseWorkspaceLocalLinks(`# Fixture\n\n${html}\n`, 'Fixture.md');
assert.equal(parsed.links.length, 0, 'HTML must not enter the rewrite/delete edge graph');
assert.deepEqual(parsed.unevaluated, [{ sourcePath: 'Fixture.md', raw: html,
  reason: 'html', start: 11, htmlTargets: ['assets/a%2Fb.png', 'Notes/Plan#Final.md'] }]);
assert.equal(parseWorkspaceLocalLinks('```html\n<img src="image.png">\n```', 'Fixture.md').unevaluated.length, 0);
assert.equal(parseWorkspaceLocalLinks('`<img src="image.png">`', 'Fixture.md').unevaluated.length, 0);
assert.equal(parseWorkspaceLocalLinks('---\nexample: <img src="image.png">\n---\n# Fixture', 'Fixture.md').unevaluated.length, 0);

const hiddenCssDependency = '<img src="stable.png" style="background-image:image-set(\'moved.png\' 1x)">';
const hiddenCssPlan = createWorkspaceFileOperationPlan({ kind: 'move', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
  selections: [{ sourcePath: 'moved.png', destinationPath: 'renamed.png' }],
  snapshots: [{ workspaceId: 'w1', entries: [
    { identity: 'id:HTML.md', kind: 'file', path: 'HTML.md', markdownContent: hiddenCssDependency },
    { identity: 'id:stable.png', kind: 'file', path: 'stable.png' },
    { identity: 'id:moved.png', kind: 'file', path: 'moved.png' },
  ] }] });
assert.equal(hiddenCssPlan.readiness, 'blocked', 'A recognized src cannot hide an unsupported CSS dependency');
assert.equal(hiddenCssPlan.linkAssessment?.blockers[0]?.reason, 'unevaluated-link');

for (const content of [
  '<div>\n<img src="stable.png"><meta http-equiv="refresh" content="0; url=moved.md">\n</div>',
  '<meta http-equiv="refresh" content="0; url=moved.md">',
  '<img src="stable.png" attributionsrc="moved.md">',
  '<img attributionsrc="moved.md">',
  '<img src="stable.png" custom-resource="moved.md">',
  '<div>\n<img src="stable.png"><custom-element resource="moved.md"></custom-element>\n</div>',
]) {
  const plan = createWorkspaceFileOperationPlan({ kind: 'move', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
    selections: [{ sourcePath: 'moved.md', destinationPath: 'renamed.md' }],
    snapshots: [{ workspaceId: 'w1', entries: [
      { identity: 'id:HTML.md', kind: 'file', path: 'HTML.md', markdownContent: content },
      { identity: 'id:stable.png', kind: 'file', path: 'stable.png' },
      { identity: 'id:moved.md', kind: 'file', path: 'moved.md', markdownContent: '# Moved' },
    ] }] });
  assert.equal(plan.readiness, 'blocked', `An opaque HTML resource must block: ${content}`);
  assert.equal(plan.linkAssessment?.blockers[0]?.reason, 'unevaluated-link');
}

const entityImage = '<img src="a&sol;b.png" alt="Image">';
const entityPlan = createWorkspaceFileOperationPlan({ kind: 'move', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
  selections: [{ sourcePath: 'a&sol;b.png', destinationPath: 'renamed.png' }],
  snapshots: [{ workspaceId: 'w1', entries: [
    { identity: 'id:HTML.md', kind: 'file', path: 'HTML.md', markdownContent: entityImage },
    { identity: 'id:entity-image', kind: 'file', path: 'a&sol;b.png' },
    { identity: 'id:browser-image', kind: 'file', path: 'a/b.png' },
  ] }] });
assert.equal(entityPlan.readiness, 'blocked', 'Entity interpretation must match the notebook image reader');
assert.equal(entityPlan.linkAssessment?.blockers[0]?.reason, 'unevaluated-link');

const encodedLeadingSlashImage = '<img src="%2Fimage.png" alt="Fixture">';
const encodedLeadingSlashLinks = parseWorkspaceLocalLinks(encodedLeadingSlashImage, 'Notes/Doc.md');
assert.deepEqual(encodedLeadingSlashLinks.unevaluated, [{ sourcePath: 'Notes/Doc.md',
  raw: encodedLeadingSlashImage, reason: 'html', start: 0 }],
  'An encoded leading slash must not turn a relative image into certified workspace-root evidence');
const encodedLeadingSlashPlan = createWorkspaceFileOperationPlan({ kind: 'move', sourceWorkspaceId: 'w1', destinationWorkspaceId: 'w1',
  selections: [{ sourcePath: 'Notes/image.png', destinationPath: 'Notes/renamed.png' }],
  snapshots: [{ workspaceId: 'w1', entries: [
    { identity: 'id:Notes/Doc.md', kind: 'file', path: 'Notes/Doc.md', markdownContent: encodedLeadingSlashImage },
    { identity: 'id:relative-image', kind: 'file', path: 'Notes/image.png' },
    { identity: 'id:root-image', kind: 'file', path: 'image.png' },
  ] }] });
assert.equal(encodedLeadingSlashPlan.readiness, 'blocked', 'Moving the rendered relative image must remain protected');
assert.equal(encodedLeadingSlashPlan.linkAssessment?.blockers[0]?.reason, 'unevaluated-link');

console.log('workspace HTML link safety: static local path evidence, whole-node certification, unsafe syntax, byte spans, code/frontmatter masking OK');
